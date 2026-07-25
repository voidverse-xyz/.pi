/**
 * Codex account usage limits (including 5h and weekly rate-limit windows).
 *
 * Talks to the local `codex` CLI's app-server over stdio (JSON-RPC,
 * `account/rateLimits/read`) — the same data the Codex CLI itself uses for
 * its rate-limit indicators.
 *
 * Footer: publishes the shortest window returned by Codex via
 * `ctx.ui.setStatus()` — 5h when available, otherwise a longer window such as
 * 7d. It emits bare content; the status-line extension owns the separators
 * between footer segments, so any footer can display it without this extension
 * touching that extension's code at all.
 *
 * Command: `/codex-usage` shows every returned window, plus the plan and
 * credits, as a multi-line toast notification via `ctx.ui.notify()`.
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
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const STATUS_KEY = "codex-usage";
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

interface LabeledRateLimitWindow {
	fallbackLabel: "5h" | "7d";
	window: RateLimitWindow;
}

type AuthMode = "apikey" | "chatgpt" | "chatgptAuthTokens" | "agentIdentity" | "personalAccessToken" | "bedrockApiKey";

const SUBSCRIPTION_AUTH_MODES: ReadonlySet<AuthMode> = new Set(["chatgpt", "chatgptAuthTokens"]);
const CODEX_PROVIDER_ID = "openai-codex";

function formatWindowLabel(mins: number | null): string {
	if (mins === null) return ""; // let callers fall back to their own label (e.g. "5h"/"7d")
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

function windowColor(percent: number): "dim" | "success" | "warning" | "error" {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	if (percent > 50) return "success";
	return "dim";
}

// Plain (un-themed) window text — shared by the colored footer status and the
// notify() toast, which takes a single string with no theming.
function formatWindowText(label: string, win: RateLimitWindow): string {
	const pct = Math.round(win.usedPercent);
	return `${formatWindowLabel(win.windowDurationMins) || label} ${pct}% (${formatResetIn(win.resetsAt)})`;
}

function getRateLimitWindows(snapshot: RateLimitSnapshot): LabeledRateLimitWindow[] {
	const windows: LabeledRateLimitWindow[] = [];
	if (snapshot.primary) windows.push({ fallbackLabel: "5h", window: snapshot.primary });
	if (snapshot.secondary) windows.push({ fallbackLabel: "7d", window: snapshot.secondary });

	return windows.sort((left, right) => {
		const leftDuration = left.window.windowDurationMins ?? Number.POSITIVE_INFINITY;
		const rightDuration = right.window.windowDurationMins ?? Number.POSITIVE_INFINITY;
		return leftDuration - rightDuration;
	});
}

export function formatUsageLines(snapshot: RateLimitSnapshot): string[] {
	const lines: string[] = ["Codex usage"];
	if (snapshot.planType) lines.push(`Plan: ${snapshot.planType}`);
	for (const { fallbackLabel, window } of getRateLimitWindows(snapshot)) {
		lines.push(formatWindowText(fallbackLabel, window));
	}
	if (snapshot.credits) {
		const creditsText = snapshot.credits.unlimited
			? "unlimited"
			: (snapshot.credits.balance ?? "unknown");
		lines.push(`Credits: ${creditsText}`);
	}
	if (lines.length === 1) lines.push("no data available");
	return lines;
}

function formatWindow(entry: LabeledRateLimitWindow | undefined, theme: ExtensionContext["ui"]["theme"]): string {
	if (!entry) return "";
	const { fallbackLabel, window } = entry;
	return theme.fg(windowColor(Math.round(window.usedPercent)), formatWindowText(fallbackLabel, window));
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

		const cleanup = () => {
			// An old process may emit exit after a replacement has already started;
			// never let that stale event tear down the new client.
			if (this.child !== child) return;
			this.child = undefined;
			this.initialized = undefined;
			this.buffer = "";
			this.authMode = null;
			for (const { reject } of this.pending.values()) reject(new Error("codex app-server unavailable"));
			this.pending.clear();
		};
		child.on("exit", cleanup);
		child.on("error", cleanup);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleChunk(chunk));
		// Writing to a dead pipe (codex missing / app-server crashed) emits "error"
		// on stdin, not on the ChildProcess — without this listener that becomes an
		// uncaught exception and crashes Pi, defeating the "fail silently" contract.
		child.stdin.on("error", cleanup);
		// Drain stderr so a chatty app-server can't fill the OS pipe buffer (~64KB)
		// and block, which would silently wedge every request behind its timeout.
		child.stderr.resume();

		this.initialized = this.request(child, "initialize", {
			clientInfo: { name: "pi-codex-usage", title: null, version: "1.0.2" },
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
			if (!child.stdin.writable) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error("codex app-server unavailable"));
				return;
			}
			try {
				child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
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
		const child = this.child;
		this.child = undefined;
		this.initialized = undefined;
		this.buffer = "";
		this.authMode = null;
		for (const { reject } of this.pending.values()) reject(new Error("codex usage client disposed"));
		this.pending.clear();
		child?.kill();
	}
}

export default function (pi: ExtensionAPI) {
	let client: CodexRateLimitClient | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let refresh: (() => void) | undefined;
	let refreshGeneration = 0;

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
	// there's genuinely no rate-limit data without a codex/ChatGPT login.
	pi.registerCommand("codex-usage", {
		description: "Show Codex rate-limit windows, plan, and credits",
		handler: async (_args, ctx) => {
			const activeClient = ensureClient();
			try {
				const authMode = await activeClient.getAuthMode();
				if (!authMode || !SUBSCRIPTION_AUTH_MODES.has(authMode)) {
					ctx.ui.notify("Codex usage needs a ChatGPT subscription login (not an API key).", "warning");
					return;
				}

				const snapshot = await activeClient.readRateLimits();

				// notify() takes a single un-themed string; embed newlines so it renders
				// as a multi-line block (Pi builds a Text component from the string).
				ctx.ui.notify(formatUsageLines(snapshot).join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(
					`Could not reach codex: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		refresh = () => {
			const generation = ++refreshGeneration;
			if (ctx.model?.provider !== CODEX_PROVIDER_ID) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}

			// Start the app-server lazily only when Codex is the active provider.
			const activeClient = ensureClient();
			activeClient
				.getAuthMode()
				.then((authMode) => {
					if (generation !== refreshGeneration || client !== activeClient) return undefined;
					if (!authMode || !SUBSCRIPTION_AUTH_MODES.has(authMode)) return undefined;
					return activeClient.readRateLimits();
				})
				.then((snapshot) => {
					if (generation !== refreshGeneration || client !== activeClient) return;
					if (!snapshot) {
						ctx.ui.setStatus(STATUS_KEY, undefined);
						return;
					}
					const shortestWindow = getRateLimitWindows(snapshot)[0];
					const status = formatWindow(shortestWindow, ctx.ui.theme);
					ctx.ui.setStatus(STATUS_KEY, status || undefined);
				})
				.catch(() => {
					if (generation !== refreshGeneration) return;
					// codex not installed, not logged in, or app-server unreachable — stay silent.
					ctx.ui.setStatus(STATUS_KEY, undefined);
				});
		};

		refresh();
		// session_start can fire again (switch/resume) without an intervening
		// shutdown — clear any prior interval so they don't accumulate.
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(refresh, POLL_MS);
		pollTimer.unref?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		refreshGeneration++;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		refresh = undefined;
		client?.dispose();
		client = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
