/**
 * show_files — an LLM-callable tool that presents a curated, annotated set of
 * files to the user in a full-screen native TUI.
 *
 * The *agent* calls this when the user asks "which files implement X?" /
 * "show me the docs for Y" / for walkthroughs and onboarding: it supplies a
 * headline + summary and, per file, a short title, a why-it-matters description,
 * an optional group heading, and optional line regions to highlight (each with a
 * note). The user browses the set (preview opens on the first highlighted
 * region), pulls @-mentions into the chat editor, and can type a note back.
 *
 * Two-way by design: the tool result reports which files the user actually
 * opened, what they added to chat, and their note — so the agent learns what
 * the user cared about and can follow up. Missing paths are presented (dimmed)
 * and reported back so the agent can correct itself.
 *
 * /show-files reopens the session's last presentation after it's closed.
 *
 * Registered via pi.registerTool (modeled on pi-ask-user); the panel reuses
 * pi-browse's tree/preview/add-to-chat machinery. Headless subagents forward
 * the presentation to the parent session's TUI via the optional `ipc`
 * extension (like ask_user); the panel then names the asking subagent chain,
 * mentions land in the PARENT's chat editor, and the outcome is relayed back
 * to the child. Without pi-ipc they get a graceful error instead.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type FileSpec, type PresentedFile, resolveFiles } from "./files.ts";
import { createShowFilesPanel, type ShowFilesOutcome } from "./panel.ts";

const ICON_SUCCESS = ""; // nf-fa-check

// ---------------------------------------------------------------------------
// Optional ipc capability (no import — pure runtime rendezvous over pi.events).
//
// A headless subagent has no local TUI, so it forwards the presentation up to
// its parent. The transport lives in the standalone `ipc` extension; we reach
// it by emitting an `ipc:client` probe carrying a `claim` callback. If `ipc`
// is installed AND this process has a parent channel, it claims synchronously
// and does the fd round-trip; otherwise nothing claims and we return a
// graceful error. No import means dropping `ipc` can't break this extension's
// load.
//
// Message contract:
//   method: "files.show"
//   params  (child → parent): { title: string; summary?: string; files: FileSpec[] }
//                             // each .path ABSOLUTE (pre-resolved against the child's cwd)
//   result  (parent → child): { outcome: ShowFilesOutcome;   // parent-relative rels
//                               shown: string[]; missing: string[] }
//   errors: a thrown Error message propagates back as the busCall rejection
// ---------------------------------------------------------------------------

type ClaimFn = (params: unknown, meta: { method: string; from: string[] }) => Promise<unknown> | unknown;
type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface ForwardedShowResult {
	outcome: ShowFilesOutcome;
	shown: string[];
	missing: string[];
}

// Captured at session_start so the parent-side ipc:serve handler can render the
// panel on this process's TUI when a headless child forwards a files.show up to us.
let currentCtx: ExtensionContext | undefined;

function busCall<T>(pi: ExtensionAPI, channel: string, method: string, params: unknown): Promise<IpcResult<T>> {
	let claimed: ClaimFn | null = null;
	pi.events.emit(channel, {
		method,
		claim: (fn: ClaimFn) => {
			claimed = fn;
		},
	});
	if (!claimed) return Promise.resolve({ ok: false, error: "no ipc provider" });
	return Promise.resolve()
		.then(() => (claimed as ClaimFn)(params, { method, from: [] }))
		.then(
			(value) => ({ ok: true, value: value as T }) as IpcResult<T>,
			(err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as IpcResult<T>,
		);
}

// ---------------------------------------------------------------------------
// Schema — what the agent fills in.
// ---------------------------------------------------------------------------

const RegionSchema = Type.Object({
	start: Type.Number({ description: "First line of the region (1-based)" }),
	end: Type.Optional(Type.Number({ description: "Last line of the region (inclusive); omit for a single line" })),
	note: Type.Optional(Type.String({ description: "Short note shown while the user's cursor is inside this region" })),
});

const FileSchema = Type.Object({
	path: Type.String({
		description: "File or directory path, relative to the working directory (absolute paths also accepted)",
	}),
	title: Type.Optional(Type.String({ description: "Short human label for the list; defaults to the file name" })),
	description: Type.Optional(
		Type.String({ description: "One or two sentences: what this file is and why it matters for the user's question" }),
	),
	group: Type.Optional(
		Type.String({ description: "Optional section heading; consecutive files sharing a group render under it" }),
	),
	regions: Type.Optional(
		Type.Array(RegionSchema, {
			description: "Line regions to highlight; the preview opens at the first one and n/p jump between them",
		}),
	),
});

const ShowFilesParams = Type.Object({
	title: Type.String({ description: "Headline for the presentation, e.g. 'Files behind the auth flow'" }),
	summary: Type.Optional(Type.String({ description: "Short intro shown under the title (1-3 sentences)" })),
	files: Type.Array(FileSchema, {
		minItems: 1,
		description: "Files to present, in the order the user should look at them (most important first)",
	}),
});

// ---------------------------------------------------------------------------
// Tool result plumbing.
// ---------------------------------------------------------------------------

interface ShowFilesDetails extends ShowFilesOutcome {
	title: string;
	shown: string[];
	missing: string[];
	presented: boolean;
	/** True when the panel ran on the parent session's TUI (forwarded over ipc). */
	forwarded?: boolean;
}

function summarize(
	title: string,
	files: PresentedFile[],
	outcome: ShowFilesOutcome,
	opts?: { forwarded?: boolean },
): string {
	const missing = files.filter((f) => f.kind === "missing").map((f) => f.rel);
	const parts: string[] = [];
	let head = `Presented "${title}" (${files.length} file${files.length !== 1 ? "s" : ""})`;
	if (missing.length > 0) head += `. Missing paths (fix or drop them): ${missing.join(", ")}`;
	parts.push(`${head}.`);
	parts.push(
		outcome.opened.length > 0
			? `User opened: ${outcome.opened.join(", ")}.`
			: "User closed the panel without opening any file previews.",
	);
	if (outcome.added.length > 0)
		parts.push(
			opts?.forwarded
				? `User added to the parent session's chat editor (context arrives with the user's next message to the parent agent, not to you): ${outcome.added.join(" ")}.`
				: `User added to the chat editor (will arrive as context with their next message): ${outcome.added.join(" ")}.`,
		);
	if (outcome.note) parts.push(`Note from user: "${outcome.note}"`);
	if (opts?.forwarded) parts.push("(Shown on the parent session's screen — this subagent has no TUI.)");
	return parts.join("\n");
}

// Last presentation, so /show-files can reopen it after the overlay closes.
let lastPresentation: { title: string; summary?: string; specs: FileSpec[] } | null = null;

async function presentPanel(
	ctx: ExtensionContext,
	title: string,
	summary: string | undefined,
	files: PresentedFile[],
	from?: string[],
): Promise<ShowFilesOutcome> {
	return ctx.ui.custom<ShowFilesOutcome>(
		(tui, theme, keybindings, done) =>
			createShowFilesPanel({ title, summary, files, from, ctx, tui, theme, keybindings, onDone: done }),
		{
			overlay: true,
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
}

/** Resolve the specs and reject an all-missing set (shared precondition of every entry point). */
async function resolveChecked(
	cwd: string,
	specs: FileSpec[],
): Promise<{ files: PresentedFile[]; missing: string[] }> {
	const files = await resolveFiles(cwd, specs);
	const missing = files.filter((f) => f.kind === "missing").map((f) => f.rel);
	if (files.every((f) => f.kind === "missing")) {
		// Tool failures must throw; returning `isError` does not mark a custom
		// tool result as failed in Pi.
		throw new Error(`None of the given paths exist: ${missing.join(", ")}. Fix the paths and retry.`);
	}
	return { files, missing };
}

// Shared path of the two local presentation entry points (the tool's TUI branch
// and the parent-side ipc:serve claim): resolve + check the specs, record the
// presentation for /show-files, and run the panel. Deliberate: a forwarded
// presentation also becomes this session's "last" one, so /show-files on the
// parent reopens the most recent thing that was on screen.
async function resolveAndPresent(
	ctx: ExtensionContext,
	title: string,
	summary: string | undefined,
	specs: FileSpec[],
	from?: string[],
): Promise<{ files: PresentedFile[]; missing: string[]; outcome: ShowFilesOutcome }> {
	const { files, missing } = await resolveChecked(ctx.cwd, specs);
	lastPresentation = { title, summary, specs };
	const outcome = await presentPanel(ctx, title, summary, files, from);
	return { files, missing, outcome };
}

// ---------------------------------------------------------------------------
// Extension.
// ---------------------------------------------------------------------------

export default function showFilesExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "show_files",
		label: "Show Files",
		description:
			"Present a curated set of files to the user in a full-screen browsable panel. Use it when the user asks " +
			"which files implement a feature, where the docs for something live, or wants a guided tour of part of the " +
			"codebase. Give the presentation a title and short summary; give each file a title and a why-it-matters " +
			"description, optionally grouped into sections, with line regions highlighting the exact code. Markdown and " +
			"HTML files preview rendered by default (give regions when exact lines matter — that forces the raw view). " +
			"From a subagent the panel appears on the parent session's screen and mentions go to the parent's chat " +
			"editor. The result reports what the user opened, what they added to chat, and any note they typed — use " +
			"that feedback.",
		promptSnippet:
			"show_files — present an annotated, browsable set of files (titles, descriptions, highlighted line regions) to the user",
		promptGuidelines: [
			'When the user asks "which files do X" or "show me the docs/code for Y", call show_files with the relevant files instead of listing paths in prose.',
			"Order files most-important-first, give each a short title and a one-sentence description, and use `regions` to point at the exact lines (with a note) rather than making the user hunt. Markdown/HTML preview rendered unless the spec has regions.",
			"Use `group` to section 4+ files (e.g. 'Core flow', 'Tests', 'Config').",
			"Read the tool result: it says which files the user actually opened, what they pulled into chat, and any note they typed — follow up on that instead of re-explaining everything.",
		],
		parameters: ShowFilesParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const specs = params.files as FileSpec[];

			if (ctx.mode !== "tui" || !ctx.hasUI) {
				// Headless subagent — forward to the parent's TUI via the optional `ipc`
				// extension. Paths are pre-resolved to absolute against THIS process's cwd
				// so the parent presents the same files regardless of its own cwd. The
				// parent stamps our identity onto the request's `from`, so the user sees
				// which subagent is showing files. If ipc isn't installed or there's no
				// parent channel, nothing claims the probe and we return a graceful error.
				const { files } = await resolveChecked(ctx.cwd, specs);
				const fwdFiles = specs.map((s, i) => ({ ...s, path: files[i]!.abs }));
				const res = await busCall<ForwardedShowResult>(pi, "ipc:client", "files.show", {
					title: params.title,
					summary: params.summary,
					files: fwdFiles,
				});
				if (!res.ok) {
					throw new Error(
						`show_files needs an interactive UI and none is reachable (${res.error}). Describe the files in prose instead.`,
					);
				}
				const details: ShowFilesDetails = {
					title: params.title,
					shown: res.value.shown,
					missing: res.value.missing,
					presented: true,
					forwarded: true,
					...res.value.outcome,
				};
				return {
					content: [{ type: "text", text: summarize(params.title, files, res.value.outcome, { forwarded: true }) }],
					details,
				};
			}

			const { files, missing, outcome } = await resolveAndPresent(ctx, params.title, params.summary, specs);

			const details: ShowFilesDetails = {
				title: params.title,
				shown: files.map((f) => f.rel),
				missing,
				presented: true,
				...outcome,
			};
			return { content: [{ type: "text", text: summarize(params.title, files, outcome) }], details };
		},

		renderCall(args, theme, _context) {
			const count = Array.isArray(args.files) ? args.files.length : 0;
			let text = theme.fg("toolTitle", theme.bold("show_files "));
			text += theme.fg("text", `"${args.title}"`);
			text += theme.fg("muted", ` — ${count} file${count !== 1 ? "s" : ""}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as ShowFilesDetails | undefined;
			if (!details || !details.presented) {
				const t = result.content[0];
				return new Text(theme.fg("warning", t?.type === "text" ? t.text : ""), 0, 0);
			}
			const lines: string[] = [];
			const openedTxt =
				details.opened.length > 0 ? `opened ${details.opened.length}/${details.shown.length}` : "nothing opened";
			let head = `${theme.fg("success", `${ICON_SUCCESS} `)}${theme.fg("accent", details.title)}${theme.fg("muted", ` — ${openedTxt}`)}`;
			if (details.missing.length > 0) head += theme.fg("warning", ` · ${details.missing.length} missing`);
			if (details.forwarded) head += theme.fg("dim", " · via parent");
			lines.push(head);
			if (details.added.length > 0) lines.push(theme.fg("text", `  added to chat: ${details.added.join(" ")}`));
			if (details.note) lines.push(theme.fg("text", `  note: ${details.note}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// Parent side: when a headless child forwards a "files.show" up through the `ipc`
	// extension, ipc probes `ipc:serve` for a capability that can render it. Claim it
	// only when this process has an interactive TUI (otherwise ipc forwards further
	// up). The claim is synchronous so the probe sees it; `meta.from` names the
	// asking subagent chain. pi-ipc serializes local presentations process-wide, so
	// parallel forwarding subagents show one panel after another.
	pi.events.on("ipc:serve", (data) => {
		const { method, claim } = data as { method: string; claim: (fn: ClaimFn) => void };
		if (method !== "files.show" || currentCtx?.mode !== "tui" || !currentCtx.hasUI) return;
		claim(async (params, meta) => {
			const req = params as { title?: string; summary?: string; files?: FileSpec[] };
			const ctx = currentCtx as ExtensionContext;
			const title = typeof req.title === "string" && req.title ? req.title : "Files";
			const summary = typeof req.summary === "string" && req.summary ? req.summary : undefined;
			const specs = Array.isArray(req.files) ? req.files : [];
			if (specs.length === 0) throw new Error("no files given");
			const { files, missing, outcome } = await resolveAndPresent(ctx, title, summary, specs, meta.from);
			const result: ForwardedShowResult = { outcome, shown: files.map((f) => f.rel), missing };
			return result;
		});
	});

	pi.on("session_start", (event, ctx) => {
		currentCtx = ctx;
		// Module state may survive session replacement through the loader cache.
		// Never let /show-files reopen another session's presentation.
		if (event.reason !== "reload") lastPresentation = null;
	});

	pi.on("session_shutdown", () => {
		currentCtx = undefined;
	});

	pi.registerCommand("show-files", {
		description: "Reopen the agent's last show_files presentation",
		handler: async (_args, ctx) => {
			// ctx.ui.custom() needs a real TUI, not just any UI surface — gate on the
			// mode explicitly (a non-"tui" ctx with hasUI would fault in presentPanel).
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/show-files requires interactive TUI mode", "error");
				return;
			}
			if (!lastPresentation) {
				ctx.ui.notify("No show_files presentation in this session yet", "warning");
				return;
			}
			const { title, summary, specs } = lastPresentation;
			const files = await resolveFiles(ctx.cwd, specs);
			const outcome = await presentPanel(ctx, title, summary, files);
			// A command has no tool result to carry the note back — don't drop it,
			// stage it in the editor so the user can send it as a message.
			if (outcome.note) {
				const cur = ctx.ui.getEditorText();
				const sep = cur && !cur.endsWith(" ") && !cur.endsWith("\n") ? " " : "";
				ctx.ui.setEditorText(`${cur}${sep}${outcome.note}`);
				ctx.ui.notify("Note placed in the editor (reopened panels can't send notes to the agent directly)", "info");
			}
		},
	});
}
