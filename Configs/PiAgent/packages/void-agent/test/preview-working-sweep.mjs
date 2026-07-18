#!/usr/bin/env node
// Standalone preview of the Void Agent working-indicator background blocks:
// full-width animations transitioning between black and the theme gray with
// sparse theme-green Matrix character rain layered over all three rows,
// mirroring makeLineBgStyle in extensions/void-agent/index.ts so the effect can
// be eyeballed without launching pi:
//   node test/preview-working-sweep.mjs          # live, all styles stacked, ctrl+c to quit
//   node test/preview-working-sweep.mjs --frames # dump static frames per style

const RESET = "\x1b[0m";
const RESET_FG = "\x1b[39m";
const TAU = Math.PI * 2;
const TEXT = [0xcd, 0xd6, 0xf4]; // Void Agent theme text
const DIM = [0x6f, 0x70, 0x78]; // Void Agent theme dim
const BLACK = [0, 0, 0];
// Transition target: Void Agent theme prompt-field gray (`userMessageBg`).
const GRAY = [0x37, 0x37, 0x39];
const MATRIX_GREEN = [0xab, 0xdf, 0xa7]; // Void Agent theme success
const MATRIX_ROWS = 3;
const MATRIX_GLYPHS = ["0", "1", "ｱ", "ｲ", "ｳ", "ｴ", "ｵ", "ｶ", "ｷ", "ｸ", "ｹ", "ｺ", "ｻ", "ｼ", "ｽ", "ｾ", "ｿ"];
const MATRIX_SEED = 250_000;

const WIDTH = Math.min(process.stdout.columns ?? 80, 100);

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const bg = ([r, g, b]) => `\x1b[48;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;
const fg = ([r, g, b]) => `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;

function gradientAt(colors, position) {
	const wrapped = ((position % 1) + 1) % 1;
	const scaled = wrapped * colors.length;
	const index = Math.floor(scaled) % colors.length;
	return mix(colors[index], colors[(index + 1) % colors.length], scaled - Math.floor(scaled));
}

function hashUnit(value) {
	const hashed = Math.sin(value * 12.9898) * 43_758.5453;
	return hashed - Math.floor(hashed);
}

const MATRIX_FOREGROUNDS = [
	fg(MATRIX_GREEN),
	fg(mix(BLACK, MATRIX_GREEN, 0.58)),
	fg(mix(BLACK, MATRIX_GREEN, 0.3)),
];

function matrixCell(t, col, row) {
	const key = col + MATRIX_SEED;
	if (hashUnit(key * 0.754_877_666) > 0.34) return undefined;
	const step = 90 + Math.floor(hashUnit(key * 1.317) * 100);
	const cycle = MATRIX_ROWS + 3 + Math.floor(hashUnit(key * 2.417) * 3);
	const offset = Math.floor(hashUnit(key * 3.137) * cycle * step);
	const frame = Math.floor((t + offset) / step);
	const head = frame % cycle;
	const trail = head - row;
	if (trail < 0 || trail > 2) return undefined;
	const glyphIndex = Math.floor(hashUnit(key * 5.713 + frame * 0.371) * MATRIX_GLYPHS.length);
	return { glyph: MATRIX_GLYPHS[glyphIndex], foreground: MATRIX_FOREGROUNDS[trail] };
}

// Every style transitions between black and the theme gray, mirroring
// makeLineBgStyle (fixed mid-range parameters instead of per-run random ones).
const STYLES = {
	breathe: {
		text: (t) => mix(BLACK, GRAY, 0.5 - 0.5 * Math.cos((t / 2_800) * TAU)),
		pad: (t) => STYLES.breathe.text(t),
	},
	aurora: {
		text: (t) => gradientAt([BLACK, GRAY], t / 9_000),
		pad: (t, col, _tw, width) => gradientAt([BLACK, GRAY], t / 9_000 + (col / Math.max(1, width)) * 0.4),
	},
	comet: {
		text: () => BLACK,
		pad: (t, col, textWidth, width) => {
			const runway = Math.max(1, width - textWidth);
			const center = textWidth + ((t % 3_000) / 3_000) * runway;
			return mix(BLACK, GRAY, Math.exp(-(((col - center) / 6) ** 2)));
		},
	},
	shimmer: {
		text: (t) => mix(BLACK, GRAY, 0.5 + 0.5 * Math.sin(t / 180)),
		pad: (t, col) => mix(BLACK, GRAY, 0.5 + 0.5 * Math.sin(col / 14 - t / 180)),
	},
};

const visibleWidth = (line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length;

function paintStatusLine(line, width, style, t) {
	const textWidth = visibleWidth(line);
	const textBg = bg(style.text(t));
	let out = `${textBg}${line.replaceAll(RESET, `${RESET}${textBg}`)}`;
	let previous = "";
	for (let col = textWidth; col < width; col++) {
		const code = bg(style.pad(t, col, textWidth, width));
		const prefix = code === previous ? "" : code;
		const matrix = matrixCell(t, col, 1);
		out += matrix ? `${prefix}${matrix.foreground}${matrix.glyph}${RESET_FG}` : `${prefix} `;
		previous = code;
	}
	return `${out}${RESET}`;
}

function paintPaddingLine(width, style, t, textWidth, row) {
	let out = "";
	let previous = "";
	for (let col = 0; col < width; col++) {
		const code = bg(col < textWidth ? style.text(t) : style.pad(t, col, textWidth, width));
		const prefix = code === previous ? "" : code;
		const matrix = matrixCell(t, col, row);
		out += matrix ? `${prefix}${matrix.foreground}${matrix.glyph}${RESET_FG}` : `${prefix} `;
		previous = code;
	}
	return `${out}${RESET}`;
}

const SPINNER_ACCENT = [0x94, 0xe2, 0xd5]; // Void Agent theme accent (cyan)
const content = `${fg(SPINNER_ACCENT)}⠹${RESET} ${fg(TEXT)}Working…${RESET} ${fg(DIM)}(1m 12s · ↓ 62.3k tokens)${RESET}`;
// The real indicator is a three-line block: padding, status text, padding.
const block = (name, t) => {
	const style = STYLES[name];
	const textWidth = visibleWidth(content);
	return [
		paintPaddingLine(WIDTH, style, t, textWidth, 0),
		paintStatusLine(content, WIDTH, style, t),
		paintPaddingLine(WIDTH, style, t, textWidth, 2),
	];
};
const names = Object.keys(STYLES);

const ROWS_PER_STYLE = 5; // name + three block lines + blank

if (process.argv.includes("--frames")) {
	for (const name of names) {
		console.log(`\n${name}:`);
		for (let i = 0; i < 3; i++) console.log(block(name, (i / 3) * 3_000).join("\n"));
	}
} else {
	process.stdout.write("\x1b[?25l");
	process.stdout.write("\n".repeat(names.length * ROWS_PER_STYLE));
	const startedAt = Date.now();
	const paint = () => {
		const t = Date.now() - startedAt;
		process.stdout.write(`\x1b[${names.length * ROWS_PER_STYLE}A`);
		for (const name of names) process.stdout.write(`  ${name}\n${block(name, t).join("\n")}\n\n`);
	};
	const timer = setInterval(paint, 80);
	process.on("SIGINT", () => {
		clearInterval(timer);
		process.stdout.write(`\x1b[?25h${RESET}\n`);
		process.exit(0);
	});
}
