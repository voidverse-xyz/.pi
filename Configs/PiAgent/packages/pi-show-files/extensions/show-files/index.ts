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
 * pi-browse's tree/preview/add-to-chat machinery. Headless subagents get a
 * graceful error (no TUI to present on).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type FileSpec, type PresentedFile, resolveFiles } from "./files.ts";
import { createShowFilesPanel, type ShowFilesOutcome } from "./panel.ts";

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
}

function summarize(title: string, files: PresentedFile[], outcome: ShowFilesOutcome): string {
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
		parts.push(`User added to the chat editor (will arrive as context with their next message): ${outcome.added.join(" ")}.`);
	if (outcome.note) parts.push(`Note from user: "${outcome.note}"`);
	return parts.join("\n");
}

// Last presentation, so /show-files can reopen it after the overlay closes.
let lastPresentation: { title: string; summary?: string; specs: FileSpec[] } | null = null;

async function presentPanel(
	ctx: ExtensionContext,
	title: string,
	summary: string | undefined,
	files: PresentedFile[],
): Promise<ShowFilesOutcome> {
	return ctx.ui.custom<ShowFilesOutcome>(
		(tui, theme, keybindings, done) =>
			createShowFilesPanel({ title, summary, files, ctx, tui, theme, keybindings, onDone: done }),
		{
			overlay: true,
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
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
			"description, optionally grouped into sections, with line regions highlighting the exact code. The result " +
			"reports what the user opened, what they added to chat, and any note they typed — use that feedback.",
		promptSnippet:
			"show_files — present an annotated, browsable set of files (titles, descriptions, highlighted line regions) to the user",
		promptGuidelines: [
			'When the user asks "which files do X" or "show me the docs/code for Y", call show_files with the relevant files instead of listing paths in prose.',
			"Order files most-important-first, give each a short title and a one-sentence description, and use `regions` to point at the exact lines (with a note) rather than making the user hunt.",
			"Use `group` to section 4+ files (e.g. 'Core flow', 'Tests', 'Config').",
			"Read the tool result: it says which files the user actually opened, what they pulled into chat, and any note they typed — follow up on that instead of re-explaining everything.",
		],
		parameters: ShowFilesParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const specs = params.files as FileSpec[];
			const files = await resolveFiles(ctx.cwd, specs);
			const missing = files.filter((f) => f.kind === "missing").map((f) => f.rel);

			if (ctx.mode !== "tui" || !ctx.hasUI) {
				const details: ShowFilesDetails = {
					title: params.title,
					shown: [],
					missing,
					presented: false,
					opened: [],
					added: [],
				};
				return {
					content: [
						{
							type: "text",
							text: "Error: show_files needs the interactive TUI (headless session — describe the files in prose instead).",
						},
					],
					details,
					isError: true,
				};
			}

			if (files.every((f) => f.kind === "missing")) {
				const details: ShowFilesDetails = {
					title: params.title,
					shown: [],
					missing,
					presented: false,
					opened: [],
					added: [],
				};
				return {
					content: [
						{ type: "text", text: `Error: none of the given paths exist: ${missing.join(", ")}. Fix the paths and retry.` },
					],
					details,
					isError: true,
				};
			}

			lastPresentation = { title: params.title, summary: params.summary, specs };
			const outcome = await presentPanel(ctx, params.title, params.summary, files);

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
			let head = `${theme.fg("success", "✓ ")}${theme.fg("accent", details.title)}${theme.fg("muted", ` — ${openedTxt}`)}`;
			if (details.missing.length > 0) head += theme.fg("warning", ` · ${details.missing.length} missing`);
			lines.push(head);
			if (details.added.length > 0) lines.push(theme.fg("text", `  added to chat: ${details.added.join(" ")}`));
			if (details.note) lines.push(theme.fg("text", `  note: ${details.note}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("show-files", {
		description: "Reopen the agent's last show_files presentation",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
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
