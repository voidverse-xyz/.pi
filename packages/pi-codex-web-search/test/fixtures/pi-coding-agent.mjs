export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2_000;

export function defineTool(definition) {
	return definition;
}

export function formatSize(bytes) {
	return `${bytes}B`;
}

export function keyText() {
	return "ctrl+o";
}

export function truncateHead(content) {
	return {
		content,
		outputBytes: Buffer.byteLength(content),
		outputLines: content.split("\n").length,
		totalBytes: Buffer.byteLength(content),
		totalLines: content.split("\n").length,
		truncated: false,
	};
}
