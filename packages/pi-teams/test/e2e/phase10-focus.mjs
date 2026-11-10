/** Alt+N integration: real Pi Editor, captured overlay, isolated core contract. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const { createFocusBridge, FOCUS_EVENT } = await jiti.import(join(EXT, "tui/focus.ts"));
const { CURSOR_MARKER, visibleWidth } = await jiti.import("@earendil-works/pi-tui");

async function fixture(colored = false, sessionFile = null) {
 const listeners = new Map();
 const events = [];
 const notices = [];
 const sent = [];
 const overlays = [];
 let mainDraft = "";
 const pi = { events: {
  on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
  emit(name, data) { events.push({ name, data }); listeners.get(name)?.(data); },
 } };
 const tui = {
  terminal: { rows: 30, columns: 100 },
  requestRender() {},
  showOverlay(component) {
   const overlay = { component, hidden: false, hide() { this.hidden = true; } };
   overlays.push(overlay);
   return overlay;
  },
 };
 const theme = { fg: (_role, text) => colored ? `\x1b[36m${text}\x1b[39m` : text };
 const ui = {
  setWidget(_key, factory) { factory?.(tui, theme); },
  notify(text, level) { notices.push({ text, level }); },
  setEditorText(text) { mainDraft = text; },
 };
 const core = {
  status: async () => [{ address: "worker/a", label: "Source scout 界", state: "idle" }],
  peek: async () => ({ label: "Source scout 界", state: "idle", sessionFile }),
  onEvent: () => () => {},
  sendAsUser: async request => { sent.push(request); return { disposition: "accepted", delivery: "queued" }; },
 };
 const bridge = createFocusBridge(pi, core, ui, ".");
 await new Promise(resolve => setTimeout(resolve, 0));
 function open() {
  pi.events.emit(FOCUS_EVENT, { source: "teams", id: "worker/a", position: 1, total: 2 });
  return overlays.at(-1).component;
 }
 const component = open();
 await new Promise(resolve => setTimeout(resolve, 0));
 return { bridge, component, open, tui, notices, sent, events, overlays, get mainDraft() { return mainDraft; } };
}

for (const colored of [false, true]) {
 const f = await fixture(colored);
 try {
  for (const rows of [1, 2, 3, 5, 10, 24, 40]) {
   f.tui.terminal.rows = rows;
   for (const width of [1, 2, 8, 20, 40, 80, 120]) {
    const output = f.component.render(width);
    assert.ok(output.length <= rows, `height ${rows}, width ${width}`);
    assert.ok(output.every(line => visibleWidth(line) <= width), `overflow at ${rows}x${width}: ${JSON.stringify(output)}`);
   }
  }
  f.tui.terminal.rows = 30;
  const rendered = f.component.render(100);
  const output = rendered.join("\n");
  const clean = rendered.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
  if (colored) assert.ok(rendered[0].startsWith("\x1b[36m"), "heading uses theme color");
  const historyBottom = clean.findIndex(line => line.startsWith("╰"));
  const composerLabel = clean.findIndex(line => line.includes("Message agent"));
  assert.ok(composerLabel > historyBottom, "composer is outside History border");
  assert.ok(clean.filter(line => line.startsWith("│")).every(line => line.startsWith("│ ") && line.endsWith(" │")), "History has padding at both boundaries");
  assert.ok(output.includes("Source scout"), "human display label remains visible");
  assert.ok(output.includes("alt+n"), "navigation help remains visible");
  assert.ok(output.includes("History"), "history has its own labeled region");
  assert.ok(output.includes("Message agent"), "mail composer is separate from history");
  assert.ok(output.includes("╭") && output.includes("╰"), "normal layout frames transcript");
  f.component.handleInput("\x1b[5~");
  f.component.handleInput("\x1b[6~");
  assert.ok(f.component.render(100).length <= 30);
  f.component.handleInput("\x1bn");
  assert.equal(f.events.at(-1).data.action, "next");
  f.component.handleInput("\x1b");
  assert.equal(f.events.at(-1).data.action, "back");
  f.component.handleInput("\x16");
  assert.ok(f.notices.at(-1).text.includes("Image"));
  f.component.handleInput("retained draft");
  f.open();
  assert.ok(f.overlays[0].hidden, "cycling hides only the owned overlay");
  assert.ok(f.overlays.at(-1).component.render(100).join("\n").includes("retained draft"), "draft survives reopening");
 } finally { f.bridge.dispose(); }
 assert.ok(f.overlays.at(-1).hidden, "dispose hides overlay");
}

await testPopulatedHistory();

const cursorFixture = await fixture();
try {
 cursorFixture.component.focused = true;
 cursorFixture.component.handleInput(`\x1b[200~${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}\x1b[201~`);
 for (let i = 0; i < 19; i++) cursorFixture.component.handleInput("\x1b[A");
 for (const rows of [3, 10, 24]) {
  cursorFixture.tui.terminal.rows = rows;
  const output = cursorFixture.component.render(80);
  assert.ok(output.some(line => line.includes(CURSOR_MARKER)), `focused multiline cursor retained at ${rows} rows`);
 }
} finally { cursorFixture.bridge.dispose(); }

const f = await fixture();
try {
 assert.equal(f.bridge.route({ type: "input", source: "interactive", text: "hello" }).action, "handled");
 await new Promise(resolve => setTimeout(resolve, 0));
 assert.deepEqual(f.sent, [{ to: "worker/a", text: "hello" }]);
 assert.equal(f.bridge.route({ type: "input", source: "extension", text: "not mail" }), undefined);
 assert.equal(f.bridge.route({ type: "input", source: "interactive", text: "/help" }), undefined);
 f.component.handleInput("/help");
 f.component.handleInput("\r");
 assert.equal(f.mainDraft, "/help", "command returns to main without executing");
 assert.equal(f.events.at(-1).data.action, "back");
 assert.equal(f.sent.length, 1);
 assert.equal(f.bridge.route({ type: "input", source: "interactive", text: "image draft", images: [{}] }).action, "handled");
 assert.equal(f.mainDraft, "image draft");
 assert.equal(f.sent.length, 1, "image input is never sent as mail");
} finally { f.bridge.dispose(); }
console.log("Phase 10 focus: dimensions, ANSI theme, populated history/paging, keyboard, draft and mail contracts passed");

async function testPopulatedHistory() {
 const { initTheme } = await jiti.import("@earendil-works/pi-coding-agent");
 initTheme("dark", false);
 const scratch = mkdtempSync(join(tmpdir(), "pi-focus-history-"));
 const sessionFile = join(scratch, "history.jsonl");
 const entries = Array.from({ length: 30 }, (_, i) => ({
  type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: `HISTORY_${String(i).padStart(2, "0")} message 界` }], timestamp: 0 },
 }));
 writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
 let f;
 try {
  f = await fixture(true, sessionFile);
  f.tui.terminal.rows = 24;
  const clean = () => f.component.render(80).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const latest = clean();
  assert.ok(latest.join("\n").includes("HISTORY_29"), "latest message displayed from real JSONL");
  assert.ok(!latest.join("\n").includes("No messages yet."));
  const historyRows = latest.filter(line => line.startsWith("│ "));
  const messageRows = historyRows.map((line, index) => line.includes("HISTORY_") ? index : -1).filter(index => index >= 0);
  assert.ok(messageRows.length >= 2, "multiple native message components visible");
  for (let i = 1; i < messageRows.length; i++) {
   assert.ok(historyRows.slice(messageRows[i - 1] + 1, messageRows[i]).some(line => /^│\s+│$/.test(line)), "blank framed separator between messages");
  }
  f.component.handleInput("\x1b[5~");
  const older = clean();
  assert.notDeepEqual(older, latest, "PageUp changes populated viewport");
  assert.ok(older.join("\n").includes("lines above latest"));
  for (let i = 0; i < 100; i++) { f.component.handleInput("\x1b[5~"); clean(); }
  const first = clean();
  assert.ok(first.join("\n").includes("HISTORY_00"), "paging reaches first message");
  f.component.handleInput("\x1b[5~");
  assert.deepEqual(clean(), first, "PageUp clamps at oldest row");
  for (let i = 0; i < 100; i++) { f.component.handleInput("\x1b[6~"); clean(); }
  assert.deepEqual(clean(), latest, "PageDown restores and clamps latest viewport");
  for (const rows of [1, 3, 9, 10, 11, 24]) {
   f.tui.terminal.rows = rows;
   for (const width of [1, 8, 15, 16, 17, 40, 80]) {
    const output = f.component.render(width);
    assert.ok(output.length <= rows, `populated height ${rows}x${width}`);
    assert.ok(output.every(line => visibleWidth(line) <= width), `populated width ${rows}x${width}`);
    assert.equal(output.some(line => line.includes("╭")), rows >= 10 && width >= 16, "frame threshold follows available space");
   }
  }
  f.component.invalidate();
  f.tui.terminal.rows = 24;
  assert.ok(clean().join("\n").includes("HISTORY_29"), "populated transcript remains renderable after invalidation");
 } finally {
  f?.bridge.dispose();
  rmSync(scratch, { recursive: true, force: true });
 }
}
