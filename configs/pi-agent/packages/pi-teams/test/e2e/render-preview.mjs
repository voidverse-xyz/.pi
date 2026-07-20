/**
 * render-preview.mjs — render the REAL TUI components (tree widget, picker,
 * viewer chrome) with the real Void Agent theme palette to ANSI, for visual review.
 * Not part of run.sh. Prints ANSI to stdout; `--json` emits {name, lines[]}.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { EXT, jiti } from "./env.mjs";

const tree = await jiti.import(join(EXT, "tui/tree-widget.ts"));
const picker = await jiti.import(join(EXT, "tui/picker.ts"));
const viewer = await jiti.import(join(EXT, "tui/viewer.ts"));

// --- a Theme shim backed by the bundled Void Agent palette ---
const voidAgent = JSON.parse(readFileSync(join(EXT, "../../../void-agent/themes/void-agent.json"), "utf8"));
const resolve = (name) => {
	const c = voidAgent.colors[name] ?? name;
	return voidAgent.vars[c] ?? (typeof c === "string" && c.startsWith("#") ? c : undefined);
};
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const theme = {
	fg(color, text) {
		const hex = resolve(color);
		if (!hex) return text;
		const [r, g, b] = rgb(hex);
		return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
	},
	bg(color, text) {
		const hex = resolve(color);
		if (!hex) return text;
		const [r, g, b] = rgb(hex);
		return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
	},
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

const WIDTH = 78;
const panels = [];

// --- tree widget ---
panels.push({
	name: "tree widget (above the editor, while agents work)",
	lines: tree.renderTreeLines(
		[
			{ address: "scout/tmp-91c2", label: "find flaky tests", tool: "grep", summary: "Grep: retry markers in CI logs", toolUses: 6, ctxPercent: 11.3, tokens: 12_000, unread: 2 },
			{ address: "worker/tmp-3f9a", label: "lint sweep", tool: "bash", summary: "Bash: eslint src/", toolUses: 4, ctxPercent: 8, tokens: 6_000, unread: 0 },
		],
		1,
		theme,
	),
});

// --- picker (/teams) ---
const roster = [
	{ address: "planner/main", type: "planner", id: "main", state: "dormant", lifetime: "persistent", purview: "main", vitals: { state: "dormant", ctxPercent: 22, tokens: 41_000, cost: 0, turns: 9 }, unread: 0, updatedAt: "" },
	{ address: "scout/tmp-91c2", type: "scout", id: "tmp-91c2", state: "running", lifetime: "oneshot", purview: "find flaky tests", label: "find flaky tests", vitals: { state: "running", ctxPercent: 11, tokens: 12_000, cost: 0, turns: 2 }, unread: 0, updatedAt: "" },
	{ address: "worker/auth", type: "worker", id: "auth", state: "waiting", lifetime: "persistent", purview: "auth", vitals: { state: "waiting", ctxPercent: 55, tokens: 90_000, cost: 0, turns: 14 }, unread: 2, updatedAt: "" },
	{ address: "worker/tmp-3f9a", type: "worker", id: "tmp-3f9a", state: "running", lifetime: "oneshot", purview: "lint sweep", label: "lint sweep", vitals: { state: "running", ctxPercent: 8, tokens: 6_000, cost: 0, turns: 1 }, unread: 0, updatedAt: "" },
];
const archived = [{ address: "scout/tmp-77aa", retiredAt: "2026-07-14T09:00:00Z" }];
const pickerComponent = picker.createPicker({
	core: {
		status: async () => roster,
		archived: () => archived,
		agentUnreadCount: (a) => (a === "worker/auth" ? 2 : 0),
		onEvent: () => () => {},
		interrupt: async () => ({ interrupted: true }),
		interruptAllWorking: async () => ({ stopped: [], failed: [] }),
		retire: async () => ({ retired: true, archiveDir: null }),
	},
	tui: { terminal: { rows: 30 }, requestRender: () => {} },
	theme,
	onDone: () => {},
});
await new Promise((r) => setTimeout(r, 20)); // let reload() resolve
pickerComponent.handleInput("\x1b[B"); // select the second row so the accent cursor shows
panels.push({ name: "picker (/teams)", lines: pickerComponent.render(WIDTH) });
pickerComponent.dispose();

// --- viewer chrome (header/rules/input/hints; transcript omitted) ---
const viewerComponent = viewer.createViewer({
	core: {
		peek: async () => ({
			address: "worker/tmp-3f9a",
			label: "lint sweep",
			state: "running",
			vitals: { state: "running", ctxPercent: 41, tokens: 23_000, cost: 0, turns: 3 },
			sessionFile: null,
		}),
		onEvent: () => () => {},
		steer: async () => ({ steered: true }),
		sendAsUser: async () => ({}),
	},
	tui: { requestRender: () => {} },
	theme,
	address: "worker/tmp-3f9a",
	cwd: process.cwd(),
	onDone: () => {},
});
await new Promise((r) => setTimeout(r, 20));
panels.push({ name: "viewer chrome (transcript body omitted)", lines: viewerComponent.render(WIDTH) });
viewerComponent.dispose();

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(panels));
} else {
	for (const panel of panels) {
		console.log(`\n=== ${panel.name} ===`);
		for (const line of panel.lines) console.log(line);
	}
}
