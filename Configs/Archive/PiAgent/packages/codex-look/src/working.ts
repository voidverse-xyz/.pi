/**
 * Codex working indicator — clone of codex-rs/tui/src/status_indicator_widget.rs +
 * shimmer.rs: the word "Working" with a bright band sweeping across it
 * (2-second sweep, band half-width 5, fg↔bg blend), instead of a spinner glyph.
 *
 * pi's working indicator takes pre-rendered frames, so we bake the sweep into
 * a frame list. Each character carries its own self-contained SGR sequence.
 */

import { fgRgb } from "./ansi.ts";

const TEXT = "Working";
// codex shimmer: band half-width 5, blends default_fg <-> default_bg.
const BAND_HALF_WIDTH = 5;

function blend(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

export function shimmerFrames(
	base: [number, number, number] = [110, 110, 110],
	bright: [number, number, number] = [235, 235, 235],
): string[] {
	const frames: string[] = [];
	const sweep = TEXT.length + BAND_HALF_WIDTH * 2;
	for (let f = 0; f < sweep; f++) {
		const center = f - BAND_HALF_WIDTH;
		let frame = "";
		for (let i = 0; i < TEXT.length; i++) {
			const d = Math.abs(i - center);
			const t = d >= BAND_HALF_WIDTH ? 0 : 1 - d / BAND_HALF_WIDTH;
			frame += fgRgb(blend(base, bright, t), TEXT[i]);
		}
		frames.push(frame);
	}
	return frames;
}

/** codex sweep is time-based over ~2s; match that across the frame count. */
export function shimmerIntervalMs(): number {
	return Math.round(2000 / (TEXT.length + BAND_HALF_WIDTH * 2));
}
