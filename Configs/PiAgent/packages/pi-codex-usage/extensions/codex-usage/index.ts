/**
 * Codex account usage limits (5h / weekly rate-limit windows).
 *
 * Talks to the local `codex` CLI's app-server over stdio (JSON-RPC,
 * `account/rateLimits/read`) — the same data the Codex CLI itself uses for
 * its own "5h limit" / weekly limit indicators.
 *
 * Footer: publishes just the 5h window via `ctx.ui.setStatus()`, the generic
 * cross-extension footer-status channel. It emits bare content; the status-line
 * extension owns the separators between footer segments, so any footer can
 * display it without this extension touching that extension's code at all.
 *
 * Command: `/codex-usage` shows the full picture (5h + 7d windows, plan,
 * credits) as a widget above the input editor, on a highlighted background
 * (customMessageBg) so it reads as distinct from the plain transcript/editor
 * area, auto-closing after 5s.
 *
 * Footer only shows anything when both hold:
 *  - the active Pi model's provider is "openai-codex" (only relevant when
 *    actually talking to Codex through Pi)
 *  - `codex`'s own auth mode is a ChatGPT subscription ("chatgpt" /
 *    "chatgptAuthTokens"), not a raw API key — rate-limit windows are a
 *    subscription-plan concept and aren't meaningful for API-key billing.
 * The command isn't gated on active provider (an explicit ask should still
 * answer), only on auth mode, and reports why via a notification if it can't.
 *
 * Fails silently (clears its footer status) if `codex` isn't installed, isn't
 * logged in, or the app-server can't be reached — never surfaces errors there.
 *
 * Install: ~/.pi/agent/extensions/codex-usage/index.ts
 * Reload: /reload
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const STATUS_KEY = "codex-usage";
const WIDGET_KEY = "codex-usage-status";
const WIDGET_AUTO_CLOSE_MS = 5000;
const POLL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

interface RateLimitWindow {
	usedPercent: number;
	windowDurationMins: number | null;
	resetsAt: number | null; // unix seconds
}

interface CreditsSnapshot {
	hasCredits: boolean;
	unlimited: boolean;
	balance: string | null;
}

interface RateLimitSnapshot {
	primary: RateLimitWindow | null;
	secondary: RateLimitWindow | null;
	planType: string | null;
	credits: CreditsSnapshot | null;
}

type AuthMode = "apikey" | "chatgpt" | "chatgptAuthTokens" | "agentIdentity" | "personalAccessToken" | "bedrockApiKey";

const SUBSCRIPTION_AUTH_MODES: ReadonlySet<AuthMode> = new Set(["chatgpt", "chatgptAuthTokens"]);
const CODEX_PROVIDER_ID = "openai-codex";

function formatWindowLabel(mins: number | null): string {
	if (mins === null) return "?";
	if (mins % 1440 === 0) return `${mins / 1440}d`;
	if (mins % 60 === 0) return `${mins / 60}h`;
	if (mins < 60) return `${mins}m`;
	return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

// Single unit only: hours while an hour or more remains, minutes once it drops below that.
function formatResetIn(resetsAt: number | null): string {
	if (resetsAt === null) return "?";
	const ms = resetsAt * 1000 - Date.now();
	if (ms <= 0) return "now";
	const totalMinutes = Math.round(ms / 60000);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	return `${Math.floor(totalMinutes / 60)}h`;
}

// Pads a line to full width, then applies a background so the fill covers the whole row
// (not just the text) — same idea as pi-tui's internal applyBackgroundToLine, reimplemented
// here since it isn't part of pi-tui's public export barrel.
function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
	return bgFn(line + padding);
}

function windowColor(percent: number): "dim" | "success" | "warning" | "error" {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	if (percent > 50) return "success";
	return "dim";
}

function formatWindow(label: string, win: RateLimitWindow | null, theme: ExtensionContext["ui"]["theme"]): string {
	if (!win) return "";
	const pct = Math.round(win.usedPercent);
	const text = `${formatWindowLabel(win.windowDurationMins) || label} ${pct}% (${formatResetIn(win.resetsAt)})`;
	return theme.fg(windowColor(pct), text);
}

// Minimal JSON-RPC client for `codex app-server --stdio` — newline-delimited JSON,
// no Content-Length framing. Kept alive across refreshes; self-heals on crash/exit.
class CodexRateLimitClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private nextId = 1;
	private initialized: Promise<void> | undefined;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
	private authMode: AuthMode | null = null;

	private ensureStarted(): ChildProcessWithoutNullStreams {
		if (this.child) return this.child;

		const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleChunk(chunk));

		const cleanup = () => {
			this.child = undefined;
			this.initialized = undefined;
			for (const { reject } of this.pending.values()) reject(new Error("codex app-server unavailable"));
			this.pending.clear();
		};
		child.on("exit", cleanup);
		child.on("error", cleanup);

		this.initialized = this.request(child, "initialize", {
			clientInfo: { name: "pi-codex-usage", title: null, version: "1.0.0" },
			capabilities: null,
		}).then(() => undefined);

		return child;
	}

	private handleChunk(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.trim()) this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}

		if (typeof message.id === "number" && this.pending.has(message.id)) {
			const { resolve, reject } = this.pending.get(message.id)!;
			this.pending.delete(message.id);
			if (message.error) reject(new Error(message.error.message ?? "app-server error"));
			else resolve(message.result);
		}
	}

	private request(child: ChildProcessWithoutNullStreams, method: string, params: unknown): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
		});
	}

	async readRateLimits(): Promise<RateLimitSnapshot> {
		const child = this.ensureStarted();
		await this.initialized;
		const result = await this.request(child, "account/rateLimits/read", null);
		return result.rateLimits as RateLimitSnapshot;
	}

	// Auth mode barely ever changes mid-session, so cache a successful read; retry on failure
	// (e.g. app-server not ready yet) rather than caching a false negative forever.
	async getAuthMode(): Promise<AuthMode | null> {
		if (this.authMode !== null) return this.authMode;
		const child = this.ensureStarted();
		await this.initialized;
		const result = await this.request(child, "getAuthStatus", { includeToken: false, refreshToken: false });
		this.authMode = (result.authMethod as AuthMode | null) ?? null;
		return this.authMode;
	}

	dispose(): void {
		this.child?.kill();
		this.child = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let client: CodexRateLimitClient | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let refresh: (() => void) | undefined;
	let widgetCloseTimer: ReturnType<typeof setTimeout> | undefined;

	const ensureClient = (): CodexRateLimitClient => {
		if (!client) client = new CodexRateLimitClient();
		return client;
	};

	// Registered once at module scope (not inside session_start) so repeated
	// session_start firings — e.g. session switch/resume within one process —
	// never accumulate duplicate listeners. model_select reacts immediately to
	// switching to/away from the Codex provider, instead of waiting on the next
	// turn_end or poll tick.
	pi.on("turn_end", () => refresh?.());
	pi.on("model_select", () => refresh?.());

	// Not gated on active provider — an explicit ask should still get an answer,
	// even if Pi's current model isn't Codex. Auth mode is still required, since
	// there's genuinely no rate-limit data without a Codex/ChatGPT login.
	pi.registerCommand("codex-usage", {
		description: "Show full Codex account usage (5h + 7d windows, plan, credits)",
		handler: async (_args, ctx) => {
			const activeClient = ensureClient();
			try {
				const authMode = await activeClient.getAuthMode();
				if (!authMode || !SUBSCRIPTION_AUTH_MODES.has(authMode)) {
					ctx.ui.notify("Codex usage needs a ChatGPT subscription login (not an API key).", "warning");
					return;
				}

				const snapshot = await activeClient.readRateLimits();
				const theme = ctx.ui.theme;
				const lines = [theme.fg("accent", "Codex usage")];
				if (snapshot.planType) lines.push(theme.fg("dim", `Plan: ${snapshot.planType}`));

				const fiveHour = formatWindow("5h", snapshot.primary, theme);
				if (fiveHour) lines.push(fiveHour);
				const weekly = formatWindow("7d", snapshot.secondary, theme);
				if (weekly) lines.push(weekly);

				if (snapshot.credits) {
					const creditsText = snapshot.credits.unlimited
						? "unlimited"
						: (snapshot.credits.balance ?? "unknown");
					lines.push(theme.fg("dim", `Credits: ${creditsText}`));
				}

				if (widgetCloseTimer) clearTimeout(widgetCloseTimer);
				// Factory form (not the plain string[] overload) so each line can get a
				// full-width background fill — visually distinct from the plain transcript/
				// editor area, which has no background of its own.
				ctx.ui.setWidget(
					WIDGET_KEY,
					(_tui, widgetTheme) => ({
						render: (width: number): string[] => {
							const fillBg = (text: string) => widgetTheme.bg("customMessageBg", text);
							const blankRow = applyBackgroundToLine("", width, fillBg);
							const contentRows = lines.map((line) => applyBackgroundToLine(`  ${line}`, width, fillBg));
							return [blankRow, ...contentRows, blankRow];
						},
						invalidate() {},
					}),
					{ placement: "aboveEditor" },
				);
				widgetCloseTimer = setTimeout(() => {
					ctx.ui.setWidget(WIDGET_KEY, undefined);
					widgetCloseTimer = undefined;
				}, WIDGET_AUTO_CLOSE_MS);
			} catch (error) {
				ctx.ui.notify(
					`Could not reach codex: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		client = ensureClient();

		refresh = () => {
			if (!client) return;

			if (ctx.model?.provider !== CODEX_PROVIDER_ID) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}

			client
				.getAuthMode()
				.then((authMode) => {
					if (!client) return undefined;
					if (!authMode || !SUBSCRIPTION_AUTH_MODES.has(authMode)) {
						ctx.ui.setStatus(STATUS_KEY, undefined);
						return undefined;
					}
					return client.readRateLimits();
				})
				.then((snapshot) => {
					if (!snapshot) return;
					const theme = ctx.ui.theme;
					// Footer only shows the 5h window (weekly is available via /codex-usage).
					// Separators between footer segments are owned by the status-line extension,
					// so emit just the bare window text.
					const fiveHour = formatWindow("5h", snapshot.primary, theme);
					ctx.ui.setStatus(STATUS_KEY, fiveHour || undefined);
				})
				.catch(() => {
					// codex not installed, not logged in, or app-server unreachable — stay silent.
					ctx.ui.setStatus(STATUS_KEY, undefined);
				});
		};

		refresh();
		pollTimer = setInterval(refresh, POLL_MS);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		refresh = undefined;
		if (widgetCloseTimer) clearTimeout(widgetCloseTimer);
		widgetCloseTimer = undefined;
		client?.dispose();
		client = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
