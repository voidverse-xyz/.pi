import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ImageContent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { createQueuePanel, type QueueController, type QueueMode } from "./panel.ts";

const WIDGET_KEY = "queue-pending";
const ENTRY_TYPE = "queue.operation";
const CANCEL_KEY = "alt+x";
const TOGGLE_KEY = "alt+q";
const MAX_PREVIEW_ENTRIES = 5;
const MAX_ENTRIES = 100;
const MAX_TOTAL_TEXT = 256 * 1024;
const ICON_IMAGE = ""; // nf-fa-image

interface QueueEntry {
	id: string;
	text: string;
	images?: ImageContent[];
}

type QueueOperation =
	| { op: "enqueue"; entry: QueueEntry }
	| { op: "remove"; id: string }
	| { op: "update"; id: string; text: string }
	| { op: "order"; ids: string[] }
	| { op: "mode"; mode: QueueMode };

export default function queueExtension(pi: ExtensionAPI): void {
	let entries: QueueEntry[] = [];
	let mode: QueueMode = "steer";
	let onQueueChange: (() => void) | null = null;
	let idCounter = 0;
	let dispatching = false;

	function nextId(): string {
		idCounter += 1;
		return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
	}

	function persist(operation: QueueOperation): void {
		pi.appendEntry(ENTRY_TYPE, operation);
	}

	function notifyChanged(): void {
		onQueueChange?.();
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
				if (entry) entry.text = operation.text;
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
			return { op: "update", id: operation.id, text: operation.text };
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

		const visibleEntries = entries.slice(0, MAX_PREVIEW_ENTRIES);
		for (const [index, entry] of visibleEntries.entries()) {
			const preview = entry.text.replace(/\s+/g, " ").trim() || "Image only";
			const imageCount = entry.images?.length ?? 0;
			const imageMark = imageCount > 0
				? theme.fg("warning", `  ${ICON_IMAGE} ${imageCount}`)
				: "";
			output.push(fit(
				theme.fg("dim", `${String(index + 1).padStart(2)}  `) +
					theme.fg("text", preview) +
					imageMark,
			));
			if (index < visibleEntries.length - 1) output.push("");
		}
		if (entries.length > MAX_PREVIEW_ENTRIES) {
			output.push(fit(theme.fg("dim", `    +${entries.length - MAX_PREVIEW_ENTRIES} more`)));
		}

		const toggleLabel = mode === "steer" ? "follow up" : "steer";
		output.push("");
		output.push(fit(
			theme.fg("warning", CANCEL_KEY) +
				theme.fg("dim", " cancel latest   ") +
				theme.fg("warning", TOGGLE_KEY) +
				theme.fg("dim", ` ${toggleLabel}   `) +
				theme.fg("warning", "/queue") +
				theme.fg("dim", " manage"),
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
					if (width < 4) return widgetLines(ctx.ui.theme, Math.max(1, width));
					const rendered = widgetLines(ctx.ui.theme, Math.max(1, width - 2));
					if (rendered.length === 0) return [];
					const box = new Box(1, 1, (text: string) => ctx.ui.theme.bg("userMessageBg", text));
					box.addChild(new Text(rendered.join("\n"), 0, 0));
					return box.render(width);
				},
			}),
			{ placement: "aboveWorking" },
		);
	}

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		registerWidget(ctx);
		notifyChanged();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		onQueueChange = null;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveWorking" });
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
		notifyChanged();
		return entry;
	}

	function dispatchEntry(id: string, deliverAs?: QueueMode): boolean {
		const index = entries.findIndex((entry) => entry.id === id);
		if (index < 0) return false;
		const entry = entries[index]!;
		entries.splice(index, 1);
		persist({ op: "remove", id });
		notifyChanged();
		try {
			pi.sendUserMessage(contentFor(entry), deliverAs ? { deliverAs } : undefined);
			return true;
		} catch (error) {
			entries.splice(index, 0, entry);
			persist({ op: "enqueue", entry });
			persist({ op: "order", ids: entries.map((candidate) => candidate.id) });
			notifyChanged();
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
		if (!event.streamingBehavior || event.source !== "interactive") return;
		// Registered extension commands have already executed before this event.
		// Other slash inputs must pass through so Pi can expand skills/templates.
		if (event.text.trimStart().startsWith("/")) return;
		const totalText = entries.reduce((sum, entry) => sum + entry.text.length, 0);
		if (entries.length >= MAX_ENTRIES || totalText + event.text.length > MAX_TOTAL_TEXT) {
			if (ctx.mode === "tui") ctx.ui.notify("Managed queue is full; this message will use Pi's native queue", "warning");
			return;
		}
		if (entries.length === 0) {
			mode = event.streamingBehavior;
			persist({ op: "mode", mode });
		}
		const entry: QueueEntry = { id: nextId(), text: event.text, images: event.images };
		entries.push(entry);
		persist({ op: "enqueue", entry });
		notifyChanged();
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
			notifyChanged();
			ctx.ui.notify(mode === "steer" ? "Pending messages will steer" : "Pending messages will follow up", "info");
		},
	});

	async function runQueuePanel(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/queue requires interactive TUI mode", "error");
			return;
		}
		if (entries.length === 0) {
			ctx.ui.notify("No managed messages (type while the agent is busy to add one)", "info");
			return;
		}
		const controller: QueueController = {
			entries: () => entries.map((entry) => ({ id: entry.id, text: entry.text, imageCount: entry.images?.length ?? 0 })),
			mode: () => mode,
			toggleMode: () => {
				mode = mode === "steer" ? "followUp" : "steer";
				persist({ op: "mode", mode });
				notifyChanged();
				return mode;
			},
			removeAt: (index) => {
				const entry = entries[index];
				if (entry) removeEntry(entry.id);
			},
			updateText: (index, text) => {
				const entry = entries[index];
				if (!entry) return;
				const otherText = entries.reduce((sum, candidate, candidateIndex) =>
					sum + (candidateIndex === index ? 0 : candidate.text.length), 0);
				if (otherText + text.length > MAX_TOTAL_TEXT) {
					ctx.ui.notify("Edited message exceeds the managed queue text limit", "warning");
					return;
				}
				entry.text = text;
				persist({ op: "update", id: entry.id, text });
				notifyChanged();
			},
			moveBy: (index, delta) => {
				const target = index + delta;
				if (index < 0 || target < 0 || index >= entries.length || target >= entries.length) return index;
				const [entry] = entries.splice(index, 1);
				entries.splice(target, 0, entry!);
				persist({ op: "order", ids: entries.map((candidate) => candidate.id) });
				notifyChanged();
				return target;
			},
			sendNow: (index) => {
				const entry = entries[index];
				if (!entry) return;
				const idle = ctx.isIdle();
				const sent = dispatchEntry(entry.id, idle ? undefined : "steer");
				ctx.ui.notify(sent ? (idle ? "Message sent" : "Message will steer at the next boundary") : "Message could not be sent", sent ? "info" : "error");
			},
			setOnChange: (callback) => {
				onQueueChange = callback;
			},
		};
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				createQueuePanel({ ctrl: controller, tui, theme, onDone: () => done(undefined) }),
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
			},
		);
	}

	pi.registerCommand("queue", {
		description: "Manage pending messages: edit, reorder, send, delete, or change delivery mode",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /queue", "error");
				return;
			}
			await runQueuePanel(ctx);
		},
	});
}
