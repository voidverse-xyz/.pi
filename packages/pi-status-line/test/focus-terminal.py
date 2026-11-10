"""Offline POSIX keyboard acceptance; real Pi UI, mock agent mail, isolated state."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
HERE = Path(__file__).resolve().parent
harness = HERE.parents[1] / 'pi-swarm/test/terminal/run.py'
spec = importlib.util.spec_from_file_location('terminal', harness)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sdk = module.pi_package_dir()
cli = module.pi_cli()
with tempfile.TemporaryDirectory(prefix='pi-focus-terminal-') as temporary:
 root = Path(temporary)
 agent = root / 'agent'; agent.mkdir()
 (agent / 'settings.json').write_text(json.dumps({'quietStartup': True, 'enableInstallTelemetry': False}))
 output = root / 'mail.jsonl'
 state = root / 'main-state.txt'
 env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
        'PI_CODING_AGENT_DIR': str(agent), 'PI_OFFLINE': '1', 'PI_TELEMETRY': '0', 'PI_SDK_DIR': str(sdk), 'FOCUS_OUTPUT': str(output), 'FOCUS_STATE': str(state)}
 command = [shutil.which('node'), str(cli), '--no-extensions', '-e', str(HERE / 'focus-terminal.ts'),
            '-e', str(HERE.parent / 'extensions/status-line/index.ts'), '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools', '--provider', 'swarm-mock', '--model', 'scripted']
 terminal = module.Terminal(command, root, env)
 try:
  terminal.expect('alt+n')
  terminal.line('/focus-ready'); terminal.expect('FOCUS_READY')
  terminal.line('Hold the main turn')
  deadline = time.monotonic() + 10
  while not state.exists() and time.monotonic() < deadline:
   terminal.pump()
  assert state.read_text() == 'started\n'
  terminal.send('\x1bn'); terminal.expect('subagents focus fixture')
  terminal.line('SUBAGENT_ONLY'); time.sleep(.3)
  terminal.send('\x1bn'); terminal.expect('teams focus fixture')
  terminal.line('TEAM_ONLY'); time.sleep(.3)
  terminal.send('\x1b'); time.sleep(.3)
  terminal.line('/focus-ready'); terminal.expect('FOCUS_READY')
  mail = [json.loads(line) for line in output.read_text().splitlines()]
  assert [(row['to'],row['text']) for row in mail] == [('subagents/reviewer','SUBAGENT_ONLY'),('teams/reviewer','TEAM_ONLY')], mail
  assert state.read_text() == 'started\n', 'focusing must not abort the active main turn'
  terminal.line('/focus-arm-dialog')
  terminal.send('\x1bn'); terminal.expect('subagents focus fixture')
  terminal.expect('FOCUS_DIALOG'); terminal.send('\x1b'); time.sleep(.2)
  terminal.send('\x1bn'); terminal.expect('subagents focus fixture')
  terminal.send('\x1b')
  print('PASS: real Alt+N/Escape, exclusive mail during a main turn, and native dialog focus cleanup')
 finally:
  terminal.close()
