export type QueueStreamingBehavior = "steer" | "followUp" | undefined;

export interface QueueInputState {
	text: string;
	source: string;
	streamingBehavior: QueueStreamingBehavior;
	isIdle: boolean;
}

export interface QueuedContent<TImage> {
	text: string;
	images?: TImage[];
}

export interface EditorRestore<TImage> {
	editorText: string;
	remaining?: QueuedContent<TImage>;
}

export interface CompactionQueueHost {
	editor: {
		addToHistory?(text: string): void;
		setText(text: string): void;
	};
	showStatus?(message: string): void;
}

export interface CompactionQueuePrototype {
	queueCompactionMessage?(this: CompactionQueueHost, text: string, mode: Exclude<QueueStreamingBehavior, undefined>): void;
	flushCompactionQueue?(this: CompactionQueueHost, options?: unknown): Promise<void>;
}

/** Restore a wrapped editor factory only while this extension still owns it. */
export function restoreOwnedEditorFactory<T>(
	getCurrent: () => T | undefined,
	setCurrent: (factory: T | undefined) => void,
	owned: T,
	previous: T | undefined,
): boolean {
	if (getCurrent() !== owned) return false;
	setCurrent(previous);
	return true;
}

/** Capture plain interactive input whenever Pi is busy, including compaction. */
export function shouldManageInput(input: QueueInputState): boolean {
	if (input.source !== "interactive") return false;
	if (input.text.trimStart().startsWith("/")) return false;
	return input.streamingBehavior !== undefined || !input.isIdle;
}

/** Keep later submissions on new lines inside one managed prompt. */
export function combineQueuedText(current: string, incoming: string): string {
	if (!current) return incoming;
	if (!incoming) return current;
	return `${current}\n${incoming}`;
}

/** Merge a later submission into an existing managed queue entry. */
export function combineQueuedContent<TImage>(
	current: QueuedContent<TImage>,
	incoming: QueuedContent<TImage>,
): QueuedContent<TImage> {
	const images = [...(current.images ?? []), ...(incoming.images ?? [])];
	return {
		text: combineQueuedText(current.text, incoming.text),
		images: images.length > 0 ? images : undefined,
	};
}

/** Restore text to the editor without silently dropping attached images. */
export function takeQueuedTextForEditor<TImage>(content: QueuedContent<TImage>): EditorRestore<TImage> | null {
	if (!content.text && content.images?.length) return null;
	return {
		editorText: content.text,
		remaining: content.images?.length
			? { text: "", images: content.images }
			: undefined,
	};
}

/** Route InteractiveMode's private compaction queue lifecycle into the managed queue. */
export function patchCompactionQueue(
	prototype: CompactionQueuePrototype,
	capture: (text: string, mode: Exclude<QueueStreamingBehavior, undefined>) => boolean,
	flushManaged: () => void,
): (() => void) | null {
	const originalQueue = prototype.queueCompactionMessage;
	const originalFlush = prototype.flushCompactionQueue;
	if (typeof originalQueue !== "function" || typeof originalFlush !== "function") return null;

	function patchedQueue(this: CompactionQueueHost, text: string, mode: Exclude<QueueStreamingBehavior, undefined>): void {
		if (!capture(text, mode)) {
			originalQueue.call(this, text, mode);
			return;
		}
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		// The submit path repaints after this method returns. Avoid reaching into
		// InteractiveMode's private renderer; its field name varies by Pi build.
		this.showStatus?.("Managed message queued for after compaction");
	}

	async function patchedFlush(this: CompactionQueueHost, options?: unknown): Promise<void> {
		try {
			await originalFlush.call(this, options);
		} finally {
			// Native Pi calls this for success, cancellation, and failure. Keep our
			// handoff equally reliable without depending on success-only extension events.
			flushManaged();
		}
	}

	prototype.queueCompactionMessage = patchedQueue;
	prototype.flushCompactionQueue = patchedFlush;
	return () => {
		if (prototype.queueCompactionMessage === patchedQueue) prototype.queueCompactionMessage = originalQueue;
		if (prototype.flushCompactionQueue === patchedFlush) prototype.flushCompactionQueue = originalFlush;
	};
}
