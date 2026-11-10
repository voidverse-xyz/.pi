#!/usr/bin/env python3
"""Real main-model tools, sole /swarm stop command, isolated offline package entry."""
import argparse
import json
import os
import shutil
import time
from run import ANSI, DisposableFixture, Terminal, HERE, compact, pi_cli


def main(scripted=False, package_root=False):
    pi = pi_cli()
    with DisposableFixture() as fixture:
        home, agent, project = [fixture.root / name for name in ('home', 'agent', 'project')]
        for path in (home, agent, project):
            path.mkdir(mode=0o700)
        env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'TERM': 'xterm-256color',
               'LANG': 'C.UTF-8', 'PI_CODING_AGENT_DIR': str(agent), 'PI_OFFLINE': '1',
               'PI_TELEMETRY': '0', 'SWARM_TERMINAL_FIXTURE': str(fixture.root / 'events.jsonl')}
        (agent / 'settings.json').write_text(json.dumps({'quietStartup': True, 'enableInstallTelemetry': False, 'tuiMode': 'fullscreen', 'fullscreenScrollbar': 'always',
            'compaction': {'enabled': False}, 'retry': {'enabled': False}, 'cacheWarming': 'off'}))
        (project / 'user.txt').write_text('Preserve fixture work\n')
        (project / '.gitignore').write_bytes(b'# Preserve existing rules\r\n')
        entry = HERE.parent.parent if package_root else HERE.parent.parent / 'extensions/index.ts'
        command = [shutil.which('node'), str(pi), '--no-extensions', '-e', str(entry), '--no-skills',
                   '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve']
        if scripted:
            command += ['-e', str(HERE.parent.parent.parent / 'pi-status-line/extensions/status-line/index.ts'), '-e', str(HERE / 'entry-fixture.ts'), '--provider', 'entry-fixture', '--model', 'first',
                        '--tools', 'swarm_start,swarm_status,swarm_control,swarm_history']
        else:
            command += ['--no-tools']
        terminal = fixture.terminal = Terminal(command, project, env)
        def events():
            path = fixture.root / 'events.jsonl'
            return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        def wait_event(kind, count=1):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if sum(row['type'] == kind for row in events()) >= count:
                    return
                terminal.pump()
            raise AssertionError(f'Missing {kind}: {events()}; terminal: {terminal.output[-5000:]}')
        try:
            terminal.expect('Entry fixture ready' if scripted else 'No models available')
            terminal.line('/swarm start forbidden')
            terminal.expect('Use /swarm stop')
            for action in (' status', ' resume'):
                terminal.line('/swarm' + action)
                deadline = time.monotonic() + .3
                while time.monotonic() < deadline:
                    terminal.pump(.03)
            assert not events() or not any(row['type'] in ('auth', 'dispatch') for row in events())
            if scripted:
                terminal.line('/fixture-model'); terminal.expect('Entry model changed')
                terminal.line('fixture chat launch'); terminal.expect('LAUNCH (Pi native provider)')
                terminal.expect('Fixture main agent returned')
                # Stop invalidates a pending proposal immediately without a focused dialog.
                terminal.line('/swarm stop'); terminal.expect('Swarm stopped.')
                terminal.line('start'); terminal.expect('Fixture main agent returned')
                assert 'Swarm emergency stop requested' in ANSI.sub('', terminal.output)
                assert not any(row['type'] == 'dispatch' for row in events())
                terminal.line('fixture chat launch'); terminal.expect('LAUNCH (Pi native provider)')
                terminal.expect('Fixture main agent returned')
                terminal.read_packet('LAUNCH (Pi native provider)')
                assert compact('"objective": "Fixture chat goal"') in terminal.last_packet
                assert not any(row['type'] == 'dispatch' for row in events()), 'Proposal alone never executes'
                terminal.line('start')
                terminal.expect('Fixture main agent returned'); wait_event('dispatch')
                terminal.line('start'); terminal.expect('Fixture main agent returned')
                assert sum(row['type'] == 'dispatch' for row in events()) == 1, 'Repeated reply cannot replay approval'
                assert [row['model'] for row in events() if row['type'] == 'dispatch'] == ['second']
                terminal.send('\x1bn'); terminal.expect('╭ Messages')
                terminal.send('\t'); terminal.expect('Main agent')
                terminal.send('\t'); terminal.expect('No topics yet')
                terminal.send('\x1b'); time.sleep(.1)
                settled_count = sum(row['type'] == 'main-settled' for row in events())
                terminal.line('fixture chat pause'); terminal.expect('Fixture main agent returned'); wait_event('settled')
                wait_event('main-settled', settled_count + 1)
                settled_count = sum(row['type'] == 'main-settled' for row in events())
                terminal.line('fixture chat view'); terminal.expect('Swarm · paused')
                terminal.send('r'); terminal.send('p'); terminal.send('s'); time.sleep(.2)
                assert sum(row['type'] == 'dispatch' for row in events()) == 1
                terminal.send('\x1b'); terminal.expect('Fixture main agent returned')
                wait_event('main-settled', settled_count + 1)
                terminal.line('/reload'); terminal.expect('Reloaded'); time.sleep(.3)
                terminal.line('fixture chat status'); terminal.expect('Fixture main agent returned')
                assert sum(row['type'] == 'dispatch' for row in events()) == 1
                terminal.line('fixture chat resume'); terminal.expect('RESUME (Pi native provider)')
                terminal.expect('Fixture main agent returned')
                assert sum(row['type'] == 'dispatch' for row in events()) == 1
                terminal.line('start')
                terminal.expect('Fixture main agent returned'); wait_event('dispatch', 2)
                terminal.send('\x1bn'); terminal.expect('╭ Messages')
                # Stop while the read-only overview owns terminal focus.
                terminal.line('/swarm stop'); terminal.expect('Swarm stopped.'); wait_event('settled', 2)
                assert sum(row['type'] == 'dispatch' for row in events()) == 2
            terminal.line('/swarm stop')
            time.sleep(.3)
            assert not (project / '.git').exists()
            assert not (project / '.swarms').exists()
            assert (project / '.gitignore').read_bytes() == b'# Preserve existing rules\r\n'
            assert (project / 'user.txt').read_text() == 'Preserve fixture work\n'
        except AssertionError as error:
            raise AssertionError(f'{error}\nRecent offline fixture events: {events()[-15:]}') from error
        finally:
            terminal.close()
    print('PASS: real main-agent tools, genuine owner chat confirmation, cancelled/replayed reply exclusion, overlay emergency stop, dashboard and offline reload' if scripted else
          'PASS: normal Swarm command entry registers without model dispatch')

def storage_reload():
    """Warm native old storage leaves, then exercise real Pi /reload and cold exit."""
    wrapper = HERE.parents[3] / 'agent/bin/pi'
    if wrapper.is_file() and os.access(wrapper, os.X_OK):
        launcher, launcher_label = [str(wrapper)], 'managed agent/bin/pi wrapper'
    else:
        launcher = [shutil.which('node'), str(pi_cli())]
        launcher_label = 'verified pi_cli() JavaScript entry via node (wrapper unavailable)'
    with DisposableFixture() as fixture:
        home, agent, project = [fixture.root / name for name in ('home', 'agent', 'project')]
        for path in (home, agent, project):
            path.mkdir(mode=0o700)
        env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'TERM': 'xterm-256color',
               'LANG': 'C.UTF-8', 'PI_CODING_AGENT_DIR': str(agent), 'PI_OFFLINE': '1',
               'PI_TELEMETRY': '0', 'PI_SKIP_VERSION_CHECK': '1'}
        (agent / 'settings.json').write_text(json.dumps({'quietStartup': True,
            'enableInstallTelemetry': False, 'tuiMode': 'fullscreen',
            'compaction': {'enabled': False}, 'retry': {'enabled': False}, 'cacheWarming': 'off'}))
        sources = HERE.parent.parent / 'extensions/swarm'
        copied = fixture.root / 'swarm'
        shutil.copytree(sources, copied)
        lease = copied / 'store/lease.mjs'
        files = copied / 'store/files.mjs'
        errors = copied / 'errors.mjs'
        replacements = ((lease, 'export const LEASE_RUNTIME_VERSION = 1;', ''),
                        (files, 'export const FILES_RUNTIME_VERSION = 1;', ''),
                        (lease, 'export function inspectReservation(', 'function inspectReservation('),
                        (errors, next(line for line in errors.read_text().splitlines(True) if line.lstrip().startswith('RUNTIME_STALE:')), ''))
        for path, old, new in replacements:
            text = path.read_text()
            assert text.count(old) == 1, f'Old-runtime fixture marker missing: {old}'
            path.write_text(text.replace(old, new))
        diagnostic = fixture.root / 'storage-diagnostic.ts'
        result = fixture.root / 'storage-result.json'
        # This import warms Pi's native ESM cache, not a synthetic jiti/Node cache.
        diagnostic.write_text('''import { inspectLease } from "./swarm/store/lease.mjs";
import { SwarmError, failureDiagnostic } from "./swarm/errors.mjs";
import { writeFileSync } from "node:fs";
export default function (pi) {
    if (typeof inspectLease !== "function") throw new Error("Storage warm import failed");
    pi.registerCommand("storage-warm", { handler: async (_args, ctx) => {
        writeFileSync(RESULT_PATH, JSON.stringify(failureDiagnostic(new SwarmError("RUNTIME_STALE", "RAW-PRIVATE-SENTINEL"), "setup")), { mode: 0o600 });
        ctx.ui.notify("Storage native leaves warmed", "info");
    }});
}
'''.replace('RESULT_PATH', json.dumps(str(result))))
        command = launcher + ['--no-extensions', '-e', str(diagnostic), '--no-skills',
            '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--no-tools']

        def probe(terminal):
            terminal.line('/storage-probe')
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if result.exists():
                    return json.loads(result.read_text())
                terminal.pump()
            raise AssertionError('Storage probe did not produce local result')

        terminal = fixture.terminal = Terminal(command, project, env)
        try:
            terminal.expect('No models available')
            terminal.line('/storage-warm')
            terminal.expect('Storage native leaves warmed')
            assert json.loads(result.read_text())['code'] == 'FAILED', 'Warm errors must lack the new allowlist entry'
            result.unlink()
            shutil.copytree(sources, copied, dirs_exist_ok=True)
            diagnostic.write_text('''import { writeFileSync } from "node:fs";
import { SwarmController } from "./swarm/core.mjs";
import { registerMainTools } from "./swarm/main-tools.mjs";
export default function (pi) {
    pi.registerCommand("storage-probe", { handler: async (_args, ctx) => {
        let controller;
        const tools = new Map();
        // Exercise the production tool's rendered, privacy-safe error path in
        // an offline injection. No worker, model or approval is dispatched.
        registerMainTools({ registerTool: tool => tools.set(tool.name, tool) }, {
            inspect: () => ({ status: "unattached" }),
            chatControl: async () => {
                controller = await SwarmController.open({
                    workspace: ctx.cwd, agentDir: process.env.PI_CODING_AGENT_DIR,
                    runId: "storage-reload-probe", ownerSessionId: ctx.sessionManager.getSessionId(),
                    createOnly: true,
                    create: { objective: "Offline storage probe", criteria: ["No execution"], scope: ["Disposable project only"] }
                });
                const paused = controller.snapshot();
                await controller.owner("run.stop");
                await controller.system("run.settle");
                return { status: paused.status, settled: controller.snapshot().status,
                    workers: paused.workers.length, turns: paused.sessions?.turns.length ?? 0 };
            }
        });
        const output = await tools.get("swarm_start").execute("offline-probe", { objective: "Offline storage probe" }, undefined, undefined, ctx);
        const result = output.isError
            ? { code: output.details.diagnostic.code, message: output.details.diagnostic.message, display: output.content[0].text }
            : output.details;
        await controller?.close();
        writeFileSync(RESULT_PATH, JSON.stringify(result), { mode: 0o600 });
        ctx.ui.notify("Storage probe finished", "info");
    }});
}
'''.replace('RESULT_PATH', json.dumps(str(result))))
            terminal.line('/reload')
            terminal.expect('Reloaded')
            stale = probe(terminal)
            assert stale.get('code') == 'RUNTIME_STALE', stale
            for field in ('message', 'display'):
                assert 'cold-start it and resume this same session' in stale[field], stale
                assert 'do not clear it or delete ownership metadata' in stale[field], stale
                assert 'RAW-PRIVATE-SENTINEL' not in stale[field], stale
                assert 'inspectReservation' not in stale[field], 'Raw exception escaped into user-facing diagnostic'
            assert not list((agent / 'sessions').glob('*/swarm')), 'Stale open created storage'
            assert not (project / '.swarms').exists()
        finally:
            terminal.close()
        result.unlink()
        terminal = fixture.terminal = Terminal(command, project, env)
        try:
            terminal.expect('No models available')
            cold = probe(terminal)
            assert cold == {'status': 'paused', 'settled': 'stopped', 'workers': 0, 'turns': 0}, cold
            roots = list((agent / 'sessions').glob('*/swarm'))
            assert len(roots) == 1
            assert (roots[0] / 'storage-reload-probe/events.jsonl').is_file()
            assert not (roots[0] / 'controller.lock').exists()
            assert not (roots[0] / 'reservation.json').exists()
            assert not list(roots[0].glob('*/sessions/*.jsonl')), 'Probe created worker sessions'
            assert not list(project.iterdir()), 'Probe changed project'
        finally:
            terminal.close()
    print(f'PASS: offline storage /reload returns RUNTIME_STALE without storage; cold process opens paused and settles; launcher: {launcher_label}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package-root', action='store_true')
    parser.add_argument('--storage-reload', action='store_true', help='Run isolated offline native storage hot-reload regression only')
    args = parser.parse_args()
    if args.storage_reload:
        storage_reload()
    else:
        main(package_root=args.package_root)
        main(scripted=True, package_root=args.package_root)
