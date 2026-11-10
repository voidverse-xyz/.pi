import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiJiti } from '../../../tests/runtime.mjs';
const jiti = await createPiJiti(import.meta.url);
const { createAgentFocus } = await jiti.import('../extensions/status-line/agent-focus.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
function bus() {
 const listeners = new Map();
 return { on(name, fn) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn); return () => set.delete(fn); },
 emit(name, value) { for (const fn of [...(listeners.get(name) ?? [])]) fn(value); } };
}
function setup() {
 const events = bus(), lifecycle = bus(), shortcuts = new Map(), overlays = [], notices = [], widgets = new Map();
 const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {}, showOverlay(component) {
  const entry = { component, hidden: false, hide() { this.hidden = true; } }; overlays.push(entry); return entry;
 } };
 const theme = { fg: (_, text) => text, bold: text => text };
 const ui = { notify: (...args) => notices.push(args), setEditorText(text) { this.draft = text; },
  setWidget(key, factory) { if (factory) widgets.set(key, factory(tui, theme)); else widgets.delete(key); } };
 const pi = { events, on: lifecycle.on, registerShortcut(key, opts) { shortcuts.set(key, opts.handler); } };
 const ctx = { mode: 'tui', ui };
 const focus = createAgentFocus(pi, () => {});
 return { pi, events, lifecycle, shortcuts, overlays, notices, widgets, ui, ctx, focus, tui };
}
test('presenter orders and deduplicates rosters, drops invalid values, cycles and cleans up', () => {
 const h = setup(); const targets = []; h.events.on('agent-focus:focus', value => targets.push(value));
 h.events.emit('agent-focus:roster', null);
 h.events.emit('agent-focus:roster', { source: 'teams', noun: 'team', agents: [{ id: 'b', name: 'B' }, { id: 'b', name: 'B' }, null] });
 h.events.emit('agent-focus:roster', { source: 'subagents', noun: 'subagent', agents: [{ id: 'a', name: 'A\x1b' }] });
 assert.match(h.focus.indicator().text, /^\[2\]/);
 h.shortcuts.get('alt+n')(h.ctx); assert.equal(targets.at(-1).source, 'subagents');
 h.events.emit('agent-focus:navigate', { source: 'teams', id: 'b', action: 'back' }); assert.equal(h.focus.indicator().focused, true);
 h.events.emit('agent-focus:navigate', { source: 'subagents', id: 'a', action: 'next' }); assert.equal(targets.at(-1).source, 'teams');
 h.events.emit('agent-focus:navigate', { source: 'teams', id: 'b', action: 'next' }); assert.equal(targets.at(-1), null);
 h.shortcuts.get('alt+n')(h.ctx); h.lifecycle.emit('ui_prompt_start'); assert.equal(targets.at(-1), null);
 h.shortcuts.get('alt+n')(h.ctx); h.events.emit('agent-focus:roster', { source: 'subagents', noun: 'subagent', agents: [] }); assert.equal(targets.at(-1), null);
 h.lifecycle.emit('session_shutdown'); assert.equal(h.focus.indicator(), null);
});
for (const kind of ['subagents', 'teams']) {
 const { createFocusBridge } = await jiti.import(`../../pi-${kind}/extensions/${kind}/tui/focus.ts`);
 test(`${kind}: full view, routing, drafts, commands, scrolling, overlays and disposal`, async () => {
  const h = setup(), calls = [], notifications = new Set();
  let roster = [{ address: 'worker/a', label: 'Reviewer', state: 'dormant' }];
  let failure = false;
  const core = { async status() { return roster; }, onEvent(fn) { notifications.add(fn); return () => notifications.delete(fn); },
   async peek() { return { address: 'worker/a', label: 'Reviewer', state: 'dormant', sessionFile: null }; },
   async sendAsUser(args) { calls.push(args); if (failure) throw Error('mail failed'); return { delivery: 'queued', disposition: 'held' }; } };
  const bridge = createFocusBridge(h.pi, core, h.ui, '/tmp', );
  try {
   await tick(); h.shortcuts.get('alt+n')(h.ctx); await tick();
   let view = h.overlays.at(-1).component;
   assert.equal(view.render(80).length, 24);
   assert.match(view.render(80)[0], /Reviewer/);
   view.handleInput('hello'); view.handleInput('\r'); await tick();
   assert.deepEqual(calls, [{ to: 'worker/a', text: 'hello' }]);
   bridge.route({ type: 'input', source: 'interactive', text: 'image', images: [{ type: 'image', data: 'x', mimeType: 'image/png' }] });
   assert.equal(calls.length, 1); assert.match(h.notices.at(-1)[0], /Images were not sent/);
   assert.equal(bridge.route({ source: 'extension', text: 'not mail' }), undefined);
   view.handleInput('draft'); view.handleInput('\x1b'); assert.equal(h.overlays.at(-1).hidden, true);
   h.shortcuts.get('alt+n')(h.ctx); view = h.overlays.at(-1).component;
   assert.ok(view.render(80).some(line => line.includes('draft')));
   view.handleInput('\x1b'); h.shortcuts.get('alt+n')(h.ctx); view = h.overlays.at(-1).component;
   view.handleInput('\x15'); view.handleInput('/status-line'); view.handleInput('\r');
   assert.equal(h.ui.draft, '/status-line'); assert.equal(calls.length, 1);
   h.shortcuts.get('alt+n')(h.ctx); view = h.overlays.at(-1).component;
   failure = true; view.handleInput('retry me'); view.handleInput('\r'); await tick();
   view.handleInput('\x1b'); h.shortcuts.get('alt+n')(h.ctx); view = h.overlays.at(-1).component;
   assert.ok(view.render(80).some(line => line.includes('retry me')));
   h.tui.terminal.rows = 4; assert.equal(view.render(10).length, 4);
   view.handleInput('\x1b[5~'); view.handleInput('\x1b[6~');
   const newer = h.tui.showOverlay({}); h.lifecycle.emit('ui_prompt_start');
   assert.equal(newer.hidden, false); assert.equal(h.overlays.at(-2).hidden, true);
   roster = []; for (const fn of [...notifications]) fn(); await tick(); assert.equal(h.focus.indicator(), null);
  } finally { bridge.dispose(); }
  assert.equal(notifications.size, 0); assert.equal(h.widgets.size, 0);
  assert.equal(bridge.route({ source: 'interactive', text: 'stale' }), undefined);
 });
 test(`${kind}: late roster replies cannot resurrect a disposed session`, async () => {
  const h = setup(); let reply;
  const bridge = createFocusBridge(h.pi, { status: () => new Promise(r => { reply = r; }), onEvent: () => () => {} }, h.ui, '/tmp');
  bridge.dispose(); reply([{ address: 'old/a', label: 'Old', state: 'dormant' }]); await tick();
  assert.equal(h.focus.indicator(), null);
 });
}


test('explicit roster selection updates the indicator and ignores stale navigation', () => {
 const h = setup(); const targets = []; h.events.on('agent-focus:focus', value => targets.push(value));
 h.events.emit('agent-focus:roster', { source: 'swarm', noun: 'swarm agent', agents: [{ id: 'a', name: 'Builder' }, { id: 'b', name: 'Reviewer' }] });
 h.shortcuts.get('alt+n')(h.ctx);
 h.events.emit('agent-focus:navigate', { source: 'swarm', id: 'a', action: 'select', targetId: 'missing' });
 assert.equal(targets.at(-1).id, 'a');
 h.events.emit('agent-focus:navigate', { source: 'swarm', id: 'a', action: 'select', targetId: 'b' });
 assert.equal(targets.at(-1).id, 'b'); assert.match(h.focus.indicator().text, /Reviewer/);
 h.events.emit('agent-focus:navigate', { source: 'swarm', id: 'a', action: 'back' });
 assert.equal(h.focus.indicator().focused, true);
 h.events.emit('agent-focus:navigate', { source: 'swarm', id: 'b', action: 'back' });
 assert.equal(targets.at(-1), null);
});
