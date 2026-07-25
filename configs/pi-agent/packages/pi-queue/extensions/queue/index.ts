import {
	CustomEditor,
	InteractiveMode,
	type ExtensionAPI,
	type ExtensionContext,
	type ImageContent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	combineQueuedContent,
	type CompactionQueuePrototype,
	patchCompactionQueue,
	restoreOwnedEditorFactory,
	shouldManageInput,
	takeQueuedTextForEditor,
} from "./logic.ts";

const WIDGET_KEY = "queue-pending";
const ENTRY_TYPE = "queue.operation";
const CANCEL_KEY = "alt+x";
const TOGGLE_KEY = "alt+q";
const MAX_ENTRIES = 100;
const MAX_TOTAL_TEXT = 256 * 1024;
const ICON_IMAGE = ""; // nf-fa-image

interface QueueEntry {
	id: string;
	text: string;
	images?: ImageContent[];
}

type QueueMode = "steer" | "followUp";

type QueueOperation =
	| { op: "enqueue"; entry: QueueEntry }
	| { op: "remove"; id: string }
	| { op: "update"; id: string; text: string; images?: ImageContent[] }
	| { op: "order"; ids: string[] }
	| { op: "mode"; mode: QueueMode };

export default function queueExtension(pi: ExtensionAPI): void {
	let entries: QueueEntry[] = [];
	let mode: QueueMode = "steer";
	let idCounter = 0;
	let dispatching = false;
	let restoreCompactionQueue: (() => void) | null = null;
	let restoreEditor: (() => void) | null = null;

	function nextId(): string {
		idCounter += 1;
		return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
	}

	function persist(operation: QueueOperation): void {
		pi.appendEntry(ENTRY_TYPE, operation);
	}

	function applyOperation(operation: QueueOperation): void {
		switch (operation.op) {
			case "enqueue":
				if (!entries.some((entry) => entry.id === operation.entry.id)) entries.push(operation.entry);
				break;
			case "remove":
				entries = entries.filter((entry) => entry.id !== operation.id);
				break;
			case "update": {
				const entry = entries.find((candidate) => candidate.id === operation.id);
				if (entry) {
					entry.text = operation.text;
					if (operation.images !== undefined) entry.images = operation.images.length > 0 ? operation.images : undefined;
				}
				break;
			}
			case "order": {
				const byId = new Map(entries.map((entry) => [entry.id, entry]));
				const ordered = operation.ids.flatMap((id) => {
					const entry = byId.get(id);
					if (!entry) return [];
					byId.delete(id);
					return [entry];
				});
				entries = [...ordered, ...byId.values()];
				break;
			}
			case "mode":
				mode = operation.mode;
				break;
		}
	}

	function parseOperation(value: unknown): QueueOperation | null {
		if (!value || typeof value !== "object") return null;
		const operation = value as Record<string, unknown>;
		if (operation.op === "remove" && typeof operation.id === "string") {
			return { op: "remove", id: operation.id };
		}
		if (operation.op === "update" && typeof operation.id === "string" && typeof operation.text === "string") {
			const images = Array.isArray(operation.images)
				? operation.images.filter((image): image is ImageContent => Boolean(image && typeof image === "object" && (image as { type?: unknown }).type === "image"))
				: undefined;
			return { op: "update", id: operation.id, text: operation.text, images };
		}
		if (operation.op === "order" && Array.isArray(operation.ids) && operation.ids.every((id) => typeof id === "string")) {
			return { op: "order", ids: operation.ids as string[] };
		}
		if (operation.op === "mode" && (operation.mode === "steer" || operation.mode === "followUp")) {
			return { op: "mode", mode: operation.mode };
		}
		if (operation.op === "enqueue" && operation.entry && typeof operation.entry === "object") {
			const entry = operation.entry as Record<string, unknown>;
			if (typeof entry.id === "string" && typeof entry.text === "string") {
				const images = Array.isArray(entry.images)
					? entry.images.filter((image): image is ImageContent => Boolean(image && typeof image === "object" && (image as { type?: unknown }).type === "image"))
					: undefined;
				return { op: "enqueue", entry: { id: entry.id, text: entry.text, images } };
			}
		}
		return null;
	}

	function restore(ctx: ExtensionContext): void {
		entries = [];
		mode = "steer";
		for (const branchEntry of ctx.sessionManager.getBranch()) {
			if (branchEntry.type !== "custom" || branchEntry.customType !== ENTRY_TYPE) continue;
			const operation = parseOperation(branchEntry.data);
			if (operation) applyOperation(operation);
		}
		// Defend against corrupt or manually edited session data.
		entries = entries.slice(0, MAX_ENTRIES);
		while (entries.reduce((sum, entry) => sum + entry.text.length, 0) > MAX_TOTAL_TEXT) entries.pop();
	}

	function widgetLines(theme: Theme, width: number): string[] {
		if (entries.length === 0 || width < 1) return [];
		const fit = (value: string) => truncateToWidth(value, width, "…");
		const count = `${entries.length} pending`;
		const modeLabel = mode === "steer" ? "Steer next turn" : "Follow up after run";
		const modeColor = mode === "steer" ? "accent" : "success";
		const output = [
			fit(
				theme.fg(modeColor, theme.bold(modeLabel)) +
					theme.fg("dim", " · ") +
					theme.fg("muted", count),
			),
			"",
		];

		for (const [index, entry] of entries.entries()) {
			const preview = entry.text || "Image only";
			const imageCount = entry.images?.length ?? 0;
			const imageMark = imageCount > 0
				? theme.fg("warning", `  ${ICON_IMAGE} ${imageCount}`)
				: "";
			output.push(...wrapTextWithAnsi(theme.fg("text", preview) + imageMark, width));
			if (index < entries.length - 1) output.push("");
		}

		const toggleLabel = mode === "steer" ? "follow up" : "steer";
		output.push("");
		output.push(fit(
			theme.fg("warning", CANCEL_KEY) +
				theme.fg("dim", " cancel latest   ") +
				theme.fg("warning", TOGGLE_KEY) +
				theme.fg("dim", ` ${toggleLabel}`),
		));
		return output;
	}

	function registerWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			WIDGET_KEY,
			() => ({
				invalidate() {},
				render(width: number): string[] {
					// Preserve one visually blank row on both sides of the queue card.
					const withOuterPadding = (lines: string[]): string[] =>
						lines.length === 0 ? [] : ["", ...lines, ""];
					if (width < 4) return withOuterPadding(widgetLines(ctx.ui.theme, Math.max(1, width)));
					const rendered = widgetLines(ctx.ui.theme, Math.max(1, width - 2));
					if (rendered.length === 0) return [];
					const box = new Box(1, 1, (text: string) => ctx.ui.theme.bg("userMessageBg", text));
					box.addChild(new Text(rendered.join("\n"), 0, 0));
					return withOuterPadding(box.render(width));
				},
			}),
			{ placement: "aboveWorking" },
		);
	}

	function manageInput(
		text: string,
		images: ImageContent[] | undefined,
		requestedMode: QueueMode,
		ctx: ExtensionContext,
	): boolean {
		if (text.trimStart().startsWith("/")) return false;
		const latest = entries.at(-1);
		const combined = latest
			? combineQueuedContent(latest, { text, images })
			: { text, images };
		const otherText = entries.reduce((sum, entry) => sum + (entry === latest ? 0 : entry.text.length), 0);
		if (otherText + combined.text.length > MAX_TOTAL_TEXT) {
			if (ctx.mode === "tui") ctx.ui.notify("Managed queue is full; this message will use Pi's native queue", "warning");
			return false;
		}

		if (latest) {
			latest.text = combined.text;
			latest.images = combined.images;
			persist({ op: "update", id: latest.id, text: latest.text, images: latest.images });
		} else {
			mode = requestedMode;
			persist({ op: "mode", mode });
			const entry: QueueEntry = { id: nextId(), text: combined.text, images: combined.images };
			entries.push(entry);
			persist({ op: "enqueue", entry });
		}
		return true;
	}

	function flushManagedAfterCompaction(ctx: ExtensionContext): void {
		if (entries.length === 0) return;
		if (ctx.isIdle()) dispatchEntry(entries[0]!.id);
		else dispatchAll(mode);
	}

	function installCompactionCapture(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		restoreCompactionQueue?.();
		const prototype = InteractiveMode.prototype as unknown as CompactionQueuePrototype;
		restoreCompactionQueue = patchCompactionQueue(
			prototype,
			(text, requestedMode) => manageInput(text, undefined, requestedMode, ctx),
			() => flushManagedAfterCompaction(ctx),
		);
		if (!restoreCompactionQueue) {
			ctx.ui.notify("pi-queue cannot capture compaction input on this Pi version", "warning");
		}
	}

	function installEditorDequeue(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		restoreEditor?.();
		const previousFactory = ctx.ui.getEditorComponent();
		const wrapperFactory = (tui: Parameters<NonNullable<typeof previousFactory>>[0], editorTheme: Parameters<NonNullable<typeof previousFactory>>[1], keybindings: Parameters<NonNullable<typeof previousFactory>>[2]) => {
			const editor = previousFactory
				? previousFactory(tui, editorTheme, keybindings)
				: new CustomEditor(tui, editorTheme, keybindings);
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string): void => {
				const shouldRestore = matchesKey(data, "up") && entries.length > 0 && ctx.ui.getEditorText().length === 0;
				if (shouldRestore && restoreLatestToEditor(ctx)) {
					tui.requestRender();
					return;
				}
				handleInput(data);
			};
			return editor;
		};
		ctx.ui.setEditorComponent(wrapperFactory);
		restoreEditor = () => {
			restoreOwnedEditorFactory(
				() => ctx.ui.getEditorComponent(),
				(factory) => ctx.ui.setEditorComponent(factory),
				wrapperFactory,
				previousFactory,
			);
		};
	}

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		registerWidget(ctx);
		installCompactionCapture(ctx);
	});
	// resources_discover runs after every extension's session_start handler, so
	// this wraps the final editor (including Void Agent) instead of replacing it.
	pi.on("resources_discover", (_event, ctx) => {
		installEditorDequeue(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		restoreCompactionQueue?.();
		restoreCompactionQueue = null;
		restoreEditor?.();
		restoreEditor = null;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveWorking" });
	});
	pi.on("session_tree", (_event, ctx) => {
		restore(ctx);
	});

	function contentFor(entry: QueueEntry): string | ({ type: "text"; text: string } | ImageContent)[] {
		if (!entry.images?.length) return entry.text;
		return [{ type: "text", text: entry.text }, ...entry.images];
	}

	function removeEntry(id: string): QueueEntry | undefined {
		const index = entries.findIndex((entry) => entry.id === id);
		if (index < 0) return undefined;
		const [entry] = entries.splice(index, 1);
		persist({ op: "remove", id });
		return entry;
	}

	function restoreLatestToEditor(ctx: ExtensionContext): boolean {
		const entry = entries.at(-1);
		if (!entry) return false;
		const restoration = takeQueuedTextForEditor(entry);
		if (!restoration) {
			ctx.ui.notify("The pending message contains only images and cannot be restored to the editor", "info");
			return false;
		}

		if (restoration.remaining) {
			entry.text = restoration.remaining.text;
			entry.images = restoration.remaining.images;
			persist({ op: "update", id: entry.id, text: entry.text, images: entry.images });
			ctx.ui.notify("Queued text restored; attached images remain pending", "info");
		} else {
			removeEntry(entry.id);
		}
		ctx.ui.setEditorText(restoration.editorText);
		return true;
	}

	function dispatchEntry(id: string, deliverAs?: QueueMode): boolean {
		const index = entries.findIndex((entry) => entry.id === id);
		if (index < 0) return false;
		const entry = entries[index]!;
		entries.splice(index, 1);
		persist({ op: "remove", id });
		try {
			pi.sendUserMessage(contentFor(entry), deliverAs ? { deliverAs } : undefined);
			return true;
		} catch {
			entries.splice(index, 0, entry);
			persist({ op: "enqueue", entry });
			persist({ op: "order", ids: entries.map((candidate) => candidate.id) });
			return false;
		}
	}

	function dispatchAll(deliverAs: QueueMode): void {
		if (dispatching) return;
		dispatching = true;
		try {
			for (const id of entries.map((entry) => entry.id)) {
				if (!dispatchEntry(id, deliverAs)) break;
			}
		} finally {
			dispatching = false;
		}
	}

	pi.on("input", (event, ctx) => {
		if (!shouldManageInput({
			text: event.text,
			source: event.source,
			streamingBehavior: event.streamingBehavior,
			isIdle: ctx.isIdle(),
		})) return;
		if (!manageInput(event.text, event.images, event.streamingBehavior ?? "steer", ctx)) return;
		return { action: "handled" as const };
	});

	pi.on("turn_end", (_event, ctx) => {
		if (entries.length > 0 && mode === "steer" && !ctx.isIdle()) dispatchAll("steer");
	});
	pi.on("agent_end", (_event, ctx) => {
		if (entries.length > 0 && !ctx.isIdle()) dispatchAll("followUp");
	});
	pi.on("agent_settled", (_event, ctx) => {
		// Safety net for provider failures or runs that ended before normal delivery.
		if (entries.length > 0 && ctx.isIdle()) dispatchEntry(entries[0]!.id);
	});

	pi.registerShortcut(CANCEL_KEY, {
		description: "Cancel the most recent managed message",
		handler: (ctx) => {
			const entry = entries.at(-1);
			if (!entry) return;
			removeEntry(entry.id);
			ctx.ui.notify(`Last pending message cancelled${entries.length ? ` (${entries.length} left)` : ""}`, "info");
		},
	});
	pi.registerShortcut(TOGGLE_KEY, {
		description: "Toggle managed messages between steer and follow-up",
		handler: (ctx) => {
			if (entries.length === 0) return;
			mode = mode === "steer" ? "followUp" : "steer";
			persist({ op: "mode", mode });
			ctx.ui.notify(mode === "steer" ? "Pending messages will steer" : "Pending messages will follow up", "info");
		},
	});
}
