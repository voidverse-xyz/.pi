// Offline test driver only: executes production main-agent tools, with genuine
// owner editor input passed to production BEFORE consuming its proposal capability.
import { appendFileSync } from 'node:fs';
import { mainAgentAction } from '../main-agent-actions.mjs';
export function driveMainAgentTools(pi) {
 if (!process.env.SWARM_TERMINAL_FIXTURE || process.env.PI_OFFLINE !== '1') throw new Error('Offline fixture required');
 const tools = new Map();
 let pending;
 const api = Object.create(pi);
 const present = update => pi.sendMessage({ customType: 'swarm-agreement', content: update.content[0].text, display: true }, { triggerTurn: false });
 api.registerTool = definition => {
  const guarded = { ...definition, async execute(id, args, signal, update, ctx) {
   const ui = Object.create(ctx.ui);
   for (const kind of ['select', 'input', 'confirm']) ui[kind] = () => { throw new Error(`Swarm-owned modal ${kind} is forbidden`); };
   const output = await definition.execute(id, args, signal, update, Object.create(ctx, { ui: { value: ui } }));
   if (output.details?.awaitingConfirmation) {
    // Offline observation only: compare every original agreement value with real
    // rendered pages before human input. This record cannot approve the proposal.
    const { proposalId, agreement } = output.details;
    appendFileSync(process.env.SWARM_TERMINAL_FIXTURE, JSON.stringify({ type: 'agreement', data: { proposalId, agreement } }) + '\n', { mode: 0o600 });
   }
   return output;
  } };
  tools.set(definition.name, guarded); pi.registerTool(guarded);
 };
 // This wraps Swarm's input handler, not a fabricated event or a test approval.
 // Its genuine interactive input first reaches the exact production authority gate.
 api.on = (event, handler) => pi.on(event, async (data, ctx) => {
  const result = await handler(data, ctx);
  if (event !== 'input' || data.source !== 'interactive' || !pending) return result;
  const proposal = pending; pending = undefined;
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (data.text !== 'start' && !/^I confirm settlement:\s*\S/i.test(text)) return { action: 'handled' };
  const input = proposal.name === 'swarm_start' ? { proposalId: proposal.proposalId } : { action: proposal.args.action, proposalId: proposal.proposalId };
  const output = await tools.get(proposal.name).execute('main-agent-fixture-confirm', input, undefined, present, ctx);
  if (output.isError) ctx.ui.notify(output.details.error, 'warning');
  else ctx.ui.notify('Fixture chat confirmation applied', 'info');
  return { action: 'handled' };
 });
 pi.registerCommand('fixture-swarm-config', { handler: async (args, ctx) => {
  const input = JSON.parse(args);
  const output = await tools.get('swarm_start').execute('main-agent-fixture-config', input, undefined, present, ctx);
  if (output.isError) throw new Error(output.details.error);
  pending = output.details.proposalId ? { name: 'swarm_start', args: input, proposalId: output.details.proposalId } : undefined;
 } });
 pi.registerCommand('fixture-swarm', { handler: async (args, ctx) => {
  const result = await mainAgentAction(tools, ctx, args, present);
  if (result.proposalId) {
   const [action, ...parts] = args.trim().split(/\s+/);
   const name = action === 'start' ? 'swarm_start' : 'swarm_control';
   const input = action === 'start' ? { objective: args.trimStart().replace(/^start\s*/, '') }
    : { action, ...(parts[0] && ['restore', 'reconcile'].includes(action) ? { runId: parts[0] } : {}) };
   pending = { name, args: input, proposalId: result.proposalId };
  } else if (['pause', 'stop'].includes(args.trim())) pending = undefined;
  return result;
 } });
 return api;
}
