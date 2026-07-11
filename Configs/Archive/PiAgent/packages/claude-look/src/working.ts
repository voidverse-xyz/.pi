/**
 * Claude Code working indicator — a rotating orange sparkle (✻ ✽ ✢ ✳ · *)
 * next to a whimsical gerund word, the way Claude Code shows "✻ Cogitating…".
 * pi takes pre-rendered frames, so we bake one orange spinner glyph per frame
 * followed by a fixed word (the word is chosen once per session start).
 */

import { fgRgb } from "./ansi.ts";

const GLYPHS = ["✻", "✽", "✢", "✳", "∗", "✻", "✽", "✢"];
const WORDS = [
	"Cogitating", "Percolating", "Puzzling", "Ruminating", "Simmering", "Noodling",
	"Conjuring", "Pondering", "Marinating", "Synthesizing", "Untangling", "Brewing",
];
const ORANGE: [number, number, number] = [217, 119, 87];

/** Frames = the spinner glyphs; the word is appended by the caller. */
export function spinnerFrames(word: string): string[] {
	return GLYPHS.map((g) => `${fgRgb(ORANGE, g)} ${word}…`);
}

export function pickWord(seed: number): string {
	return WORDS[Math.abs(seed) % WORDS.length];
}

export function spinnerIntervalMs(): number {
	return 120;
}
