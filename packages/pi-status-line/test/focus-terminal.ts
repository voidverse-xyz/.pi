import { createMockRuntime } from '../../pi-swarm/test/sdk-env.mjs';
import { createFocusBridge as subagents } from '../../pi-subagents/extensions/subagents/tui/focus.ts';
import { createFocusBridge as teams } from '../../pi-teams/extensions/teams/tui/focus.ts';
import { appendFileSync } from 'node:fs';
export default async function(pi: any) {
 const main = await createMockRuntime(async ({ options }: any) => {
  appendFileSync(process.env.FOCUS_STATE!, 'started\n');
  if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
  appendFileSync(process.env.FOCUS_STATE!, 'aborted\n');
  return { text: 'Main turn cancelled' };
 });
 pi.registerProvider(main.modelRuntime.getProvider('swarm-mock'));
 let dialogTimer: ReturnType<typeof setTimeout> | undefined;
 pi.registerCommand('focus-arm-dialog', { description: 'Offline delayed dialog', handler: (_args: any, ctx: any) => {
  dialogTimer = setTimeout(() => { void ctx.ui.select('FOCUS_DIALOG', ['Cancel', 'Okay']); }, 500);
 } });
 const bridges: any[] = [];
 pi.on('session_start', (_event: any, ctx: any) => {
  for (const [source, bridge] of [['subagents', subagents], ['teams', teams]] as const) {
   const address = `${source}/reviewer`;
   const core: any = {
    status: async () => [{ address, label: `${source} focus fixture`, state: 'dormant' }],
    onEvent: () => () => {},
    peek: async () => ({ address, label: `${source} focus fixture`, state: 'dormant', sessionFile: null }),
    sendAsUser: async (args: any) => { appendFileSync(process.env.FOCUS_OUTPUT!, JSON.stringify(args)+'\n'); return { delivery: 'queued', disposition: 'held' }; },
   };
   bridges.push(bridge(pi, core, ctx.ui, ctx.cwd));
  }
 });
 pi.on('session_shutdown', () => { clearTimeout(dialogTimer); bridges.forEach(bridge => bridge.dispose()); });
 pi.registerCommand('focus-ready', { description: 'Offline terminal fixture', handler: (_args: any, ctx: any) => ctx.ui.notify('FOCUS_READY', 'info') });
}
