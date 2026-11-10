import { Key, matchesKey, isKeyRelease } from "@earendil-works/pi-tui";

const COMMAND = "/swarm stop";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Observe typing transparently; consume only the literal emergency submission. */
export function createEmergencyInput({ enabled, canCapture, stop, pendingChanged = () => { } }) {
	let pending = "";
	let pasting = false;
	let pasted = "";
	const update = value => { pending = value; pendingChanged(value); };
	return {
		reset() { pasting = false; pasted = ""; update(""); },
		handle(data) {
			if (!enabled()) { pasting = false; pasted = ""; if (pending) update(""); return; }
			// Pi filters release events after raw listeners, so ignore them here too.
			if (!pasting && isKeyRelease(data)) return;
			if (!pending && !pasting && !canCapture()) return;
			if (pasting || data.includes(PASTE_START)) {
				const start = pasting ? 0 : data.indexOf(PASTE_START) + PASTE_START.length;
				const end = data.indexOf(PASTE_END, start);
				pasted = (pasted + data.slice(start, end < 0 ? undefined : end)).slice(0, COMMAND.length + 1);
				pasting = end < 0;
				if (!pasting) { update(pasted === COMMAND ? COMMAND : ""); pasted = ""; }
				return;
			}
			if (pending && matchesKey(data, Key.escape)) { update(""); return; }
			if (pending && matchesKey(data, Key.backspace)) { update(pending.slice(0, -1)); return; }
			if (pending === COMMAND && matchesKey(data, Key.enter)) {
				update("");
				stop();
				return { consume: true };
			}
			const nextCharacter = COMMAND[pending.length];
			const text = nextCharacter && matchesKey(data, nextCharacter === " " ? Key.space : nextCharacter) ? nextCharacter : data;
			const candidate = pending + text;
			if ([`${COMMAND}\r`, `${COMMAND}\n`, `${COMMAND}\r\n`].includes(candidate)) {
				update("");
				stop();
				return { consume: true };
			}
			// Let '/' open dashboard search immediately, and preserve every ordinary
			// key. Only Enter for the full command bypasses the focused component.
			update(candidate && COMMAND.startsWith(candidate) ? candidate : "");
		},
	};
}
