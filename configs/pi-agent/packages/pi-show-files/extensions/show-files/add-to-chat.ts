/**
 * "Add to chat" — append an @-mention reference into the input editor.
 *
 * Non-destructive: whatever the user has already typed is preserved; the mention
 * is appended (space-separated) with a trailing space so they can keep typing.
 * Pi resolves `@path` mentions to file/dir context when the message is sent.
 *
 * Same pattern as pi-browse; the ctx here is typed structurally so both the
 * tool's ExtensionContext and a command's ExtensionCommandContext work.
 */

export interface EditorUi {
	ui: {
		getEditorText(): string;
		setEditorText(text: string): void;
		notify(message: string, level?: "info" | "warning" | "error"): void;
	};
}

export function fileMention(rel: string): string {
	return `@${rel}`;
}

export function dirMention(rel: string): string {
	return rel.endsWith("/") ? `@${rel}` : `@${rel}/`;
}

/** Line-range mention: `@path:12` for one line, `@path:12-40` for a span. */
export function linesMention(rel: string, a: number, b: number): string {
	const start = Math.min(a, b);
	const end = Math.max(a, b);
	return start === end ? `@${rel}:${start}` : `@${rel}:${start}-${end}`;
}

/** Append a mention to the editor text, keeping the user's existing draft. */
export function appendToEditor(ctx: EditorUi, mention: string): void {
	const current = ctx.ui.getEditorText();
	const sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
	ctx.ui.setEditorText(`${current}${sep}${mention} `);
}
