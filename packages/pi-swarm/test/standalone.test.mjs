import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SwarmHost } from '../extensions/swarm/host.mjs';
import { SwarmController } from '../extensions/swarm/core.mjs';
import { ModeGate } from '../extensions/swarm/host-gates.mjs';
import { prepareLayout } from '../extensions/swarm/store/layout.mjs';
import { acquireLease, inspectLease, releaseStaleLease } from '../extensions/swarm/store/lease.mjs';
import { repository } from './helpers.mjs';
import { createMockRuntime } from './sdk-env.mjs';

const specification = { objective: 'Implement one file', criteria: ['File exists'], scope: ['result.txt'] };
const approve = () => ({ approved: true, existingChanges: 'preserve', reconciled: true });
const provider = { version: 1, instanceId: 'real', revision: 1, contextRevision: 0, ready: true,
 sessionId: 'owner', selectedMode: 'off', enforcedMode: 'off', runMode: null, pendingChange: false };

test('absent Plan starts Off, appearing Plan fences tokens, and disappearing Plan stays closed', () => {
 const events = new EventEmitter(); const gate = new ModeGate({ events, sessionId: 'owner' });
 const absent = gate.capture(); assert.equal(gate.current().enforcedMode, 'off');
 events.on('pi-plan:query-mode', request => request.respond(provider));
 events.emit('pi-plan:mode-changed', provider);
 assert.equal(absent.signal.aborted, true); assert.throws(() => gate.assert(absent.token));
 const current = gate.capture(); events.removeAllListeners('pi-plan:query-mode');
 assert.throws(() => gate.assert(current.token)); assert.throws(() => gate.capture()); gate.dispose();
});
for (const broken of ['malformed', 'duplicate']) test(`${broken} Plan never becomes absent fallback`, () => {
 const events = new EventEmitter(); const gate = new ModeGate({ events, sessionId: 'owner' });
 events.on('pi-plan:query-mode', request => { request.respond(broken === 'malformed' ? {} : provider); if (broken === 'duplicate') request.respond(provider); });
 assert.throws(() => gate.capture()); events.removeAllListeners('pi-plan:query-mode'); assert.throws(() => gate.capture()); gate.dispose();
});

for (const codingTools of [undefined, ['write'], ['read']]) test(`standalone native write uses the approved bounded tool selection (${codingTools ?? 'defaults'}) without Swarm prompts`, async t => {
 const project = join(repository(t), 'plain'); mkdirSync(project);
 const allow = codingTools === undefined || codingTools.includes('write'); const agreements = [];
 const mock = await createMockRuntime(({ context }) => {
  const results = context.messages.filter(message => message.role === 'toolResult');
  const call = (name, args) => ({ toolCalls: [{ id: `call-${results.length}`, name, arguments: args }] });
  if (!results.length) return call('swarm_task', { action: 'create', id: 'task', title: 'Write', criteria: [0], dependencies: [] });
  if (results.length === 1) return call('swarm_task', { action: 'claim', taskId: 'task', kind: 'build' });
  if (results.length === 2) return call('swarm_files', { action: 'claim', paths: ['result.txt'] });
  if (results.length === 3) return call('write', { path: 'result.txt', content: 'native write' });
  return { text: 'Turn finished' };
 });
 const host = new SwarmHost({ events: new EventEmitter(), sessionId: 'owner', modelRuntime: mock.modelRuntime,
  mainModel: mock.model, tickIntervalMs: 0, requestApproval(request) { agreements.push(request); return approve(); } });
 t.after(() => host.close());
 await host.launch({ workspace: project, runId: 'standalone', specification: { ...specification, ...(codingTools ? { codingTools } : {}) } });
 await host.recruit({ id: 'builder', specialization: 'Build', brief: 'Write file', reason: 'Independent task' });
 host.wake('builder'); await host.idle();
 assert.equal(existsSync(join(project, 'result.txt')), allow);
 if (codingTools) assert.deepEqual(host.snapshot().run.sessions.codingTools, codingTools);
 assert.equal(existsSync(join(project, '.git')), false); assert.equal(existsSync(join(project, '.gitignore')), false);
 assert.match(agreements[0].integrations.mode, /none installed/);
 assert.match(agreements[0].integrations.confirmations, /Selected coding tools are authorized within this bounded run; no Swarm operation prompts/);
 if (allow) assert.equal(readFileSync(join(project, 'result.txt'), 'utf8'), 'native write');
 const write = mock.calls.at(-1).context.messages.find(message => message.role === 'toolResult' && message.toolName === 'write');
 assert.equal(Boolean(write.isError), !allow);
});

test('duplicate Safety claimants deny before approval and never fall back to bounded run policy', async t => {
 const root = repository(t); const mock = await createMockRuntime([]); const events = new EventEmitter();
 for (let i = 0; i < 2; i++) events.on('swarm:confirm-request', ({ claim }) => claim(() => assert.fail('must not invoke')));
 const host = new SwarmHost({ events, sessionId: 'owner', modelRuntime: mock.modelRuntime, mainModel: mock.model,
  requestApproval: () => assert.fail('invalid integration') });
 await assert.rejects(host.launch({ workspace: root, runId: 'duplicate', specification }), { code: 'AUTHORITY' }); await host.close();
});

test('paused run restores from another session, requires fresh approval, then continues', async t => {
 const root = repository(t); const mock = await createMockRuntime(() => ({ text: 'One bounded turn' })); const approvals = [];
 const options = { events: new EventEmitter(), modelRuntime: mock.modelRuntime, mainModel: mock.model, tickIntervalMs: 0,
  requestApproval(request) { approvals.push(request.action); return approve(); } };
 const first = new SwarmHost({ ...options, sessionId: 'session-a' });
 await first.launch({ workspace: root, runId: 'restore', specification });
 await first.recruit({ id: 'builder', specialization: 'Build', brief: 'Work', reason: 'Independent' });
 first.wake('builder'); await first.idle(); await first.close();
 const second = new SwarmHost({ ...options, sessionId: 'session-b' }); t.after(() => second.close());
 await second.restore({ workspace: root, runId: 'restore' });
 assert.equal(second.snapshot().run.ownerSessionId, 'session-b'); assert.equal(mock.calls.length, 1);
 assert.throws(() => second.wake('builder'), { code: 'HOST_DENIED' });
 await second.resume(); second.wake('builder'); await second.idle();
 assert.equal(mock.calls.length, 2); assert.deepEqual(approvals, ['launch', 'resume']);
});

test('legacy runs are refused without moving or deleting their files', async t => {
 const root = repository(t); mkdirSync(join(root, '.swarms', 'legacy'), { recursive: true });
 writeFileSync(join(root, '.swarms', 'legacy', 'events.jsonl'), 'old data');
 await assert.rejects(SwarmController.open({ workspace: root, runId: 'legacy', ownerSessionId: 'new', adopt: true }), { code: 'LEGACY_RUN' });
 assert.equal(readFileSync(join(root, '.swarms', 'legacy', 'events.jsonl'), 'utf8'), 'old data');
 assert.equal(existsSync(prepareLayout(root, 'legacy').stateRoot), false);
});

test('lease recovery discloses owner, refuses live/replaced leases and requires settled attestation', t => {
 const root = repository(t); const layout = prepareLayout(root, 'crash'); acquireLease(layout, { ownerSessionId: 'prior-session' });
 const original = inspectLease(layout); assert.equal(original.ownerSessionId, 'prior-session');
 assert.throws(() => releaseStaleLease(layout, original, { settled: true }), /still alive/);
 const pid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim());
 const stale = { ...original, pid }; writeFileSync(join(layout.ownerPath, 'owner.json'), JSON.stringify(stale));
 assert.throws(() => releaseStaleLease(layout, original, { settled: true }), /changed/);
 assert.throws(() => releaseStaleLease(layout, stale), /attestation/);
 releaseStaleLease(layout, stale, { settled: true });
 assert.equal(existsSync(layout.ownerPath), false); assert.equal(existsSync(layout.reservationPath), true);
});

test('a late Plan responder cannot regain absent-provider fallback', async () => {
 const events = new EventEmitter(); const gate = new ModeGate({ events, sessionId: 'owner' });
 events.on('pi-plan:query-mode', request => queueMicrotask(() => request.respond(provider)));
 const grant = gate.capture(); await new Promise(resolve => queueMicrotask(resolve));
 assert.equal(grant.signal.aborted, true); events.removeAllListeners('pi-plan:query-mode');
 assert.throws(() => gate.capture()); gate.dispose();
});
