#!/usr/bin/env python3
"""Offline static Pi dashboard PTY acceptance; no workers or provider requests.
Requires POSIX Python, installed Pi and Node. Uses only disposable agent config.
--tmux SESSION creates a detached window, never selects or resizes other windows.
"""
import argparse
import json
import os
import shlex
import subprocess
import time
from run import ANSI, DisposableFixture, HERE, Terminal, pi_cli, pi_package_dir


class TmuxTerminal:
    def __init__(self, command, cwd, env, session):
        invocation = "exec env -i " + " ".join(shlex.quote(f"{key}={value}") for key, value in env.items())
        invocation += " " + shlex.join(command)
        self.window = subprocess.check_output(["tmux", "new-window", "-d", "-P", "-F", "#{window_id}",
            "-t", session + ":", "-n", "swarm-ui-fixture", "-c", str(cwd), invocation], text=True).strip()
        self.output = ""
        self.closed = False
        self.process = self  # DisposableFixture keeps config until poll confirms exit.

    def poll(self):
        return 0 if self.closed else None

    def send(self, text):
        subprocess.run(["tmux", "send-keys", "-t", self.window, "-l", text], check=True)
        time.sleep(0.15)

    def line(self, text):
        self.send(text)
        self.send("\r")

    def expect(self, text, timeout=15):
        deadline = time.monotonic() + timeout
        screen = ""
        while time.monotonic() < deadline:
            screen = subprocess.check_output(["tmux", "capture-pane", "-p", "-t", self.window], text=True)
            if text in screen:
                self.output += screen
                return
            time.sleep(0.1)
        raise AssertionError(f"Missing {text!r}; fixture window:\n{screen}")

    def resize(self, columns, rows):
        subprocess.run(["tmux", "resize-window", "-t", self.window, "-x", str(columns), "-y", str(rows)], check=True)
        time.sleep(0.2)

    def close(self):
        # No worker/process spawning exists in this fixture. Terminate only its
        # window and verify removal before deleting disposable config.
        subprocess.run(["tmux", "kill-window", "-t", self.window], check=True)
        windows = subprocess.check_output(["tmux", "list-windows", "-a", "-F", "#{window_id}"], text=True)
        if self.window in windows.splitlines():
            raise RuntimeError("Fixture window exit unconfirmed")
        self.closed = True


def exercise(terminal):
    terminal.expect("Static dashboard fixture ready")
    terminal.send("\x1bn")
    terminal.expect("Swarm · running")
    terminal.send("2")
    terminal.expect("> alpha")
    if isinstance(terminal, TmuxTerminal):
        terminal.expect("Agent 2/3 · Enter messages")
        screen = subprocess.check_output(["tmux", "capture-pane", "-p", "-t", terminal.window], text=True)
        lines = screen.splitlines()
        details = next(i for i, line in enumerate(lines) if "Tasks: Fixture task" in line)
        assert lines[details + 1].startswith("│ ") and not lines[details + 1].strip("│ "), "gap after selected agent details"
        print("AGENTS capture:\n" + "\n".join(lines[:15]))
    terminal.send("j")
    terminal.expect("> beta")
    if isinstance(terminal, TmuxTerminal):
        terminal.expect("Agent 3/3 · Enter messages")
    terminal.send("\r")
    terminal.expect("Messages")
    terminal.send("\x1b[F")
    terminal.expect("Fixture history 99")
    terminal.send("/")
    terminal.expect("SEARCH")
    terminal.send("no-such-fixture")
    terminal.send("\r")
    terminal.expect("0 matches")
    terminal.send("?")
    terminal.expect("NAVIGATION")
    terminal.send("?")
    terminal.send("q")
    terminal.expect("Agents")
    terminal.send("3")
    terminal.expect("3 Topics")
    if isinstance(terminal, TmuxTerminal):
        terminal.expect("Fixture task (2)")
        terminal.expect("Participants: Main agent, alpha, beta")
        terminal.expect("Status: assigned")
        terminal.expect("Review (1)")
        terminal.expect("Topic 1/2 · Enter discussion")
        screen = subprocess.check_output(["tmux", "capture-pane", "-p", "-t", terminal.window], text=True)
        assert "Topics / Boards" not in screen and "(fixture-task)" not in screen
        topic_lines = screen.splitlines()
        heading = next(i for i, line in enumerate(topic_lines) if "Fixture task (2)" in line)
        assert "Participants:" in topic_lines[heading + 1] and "Status: assigned" in topic_lines[heading + 2]
        print("TOPICS capture:\n" + "\n".join(screen.splitlines()[:15]))
    terminal.send("\r")
    terminal.expect("Topic:")
    terminal.send("q")
    terminal.send("q")
    terminal.expect("Fixture closed-1")
    for count, state in enumerate(["paused", "stopped", "unattached"], start=2):
        terminal.line(f"/fixture-dashboard {state}")
        terminal.expect(f"Swarm · {state}")
        terminal.send("\x1b")
        terminal.expect(f"Fixture closed-{count}")
    terminal.resize(40, 16)
    terminal.line("/fixture-dashboard running")
    terminal.expect("Swarm · running")
    terminal.send("2")
    terminal.expect("alpha")
    terminal.send("q")
    terminal.expect("Fixture closed-5")
    assert "exceeds terminal width" not in ANSI.sub("", terminal.output)


def setup(root, sdk, cli):
    home, agent, project = [root / name for name in ("home", "agent", "project")]
    for path in (home, agent, project):
        path.mkdir(mode=0o700)
    (agent / "settings.json").write_text(json.dumps({"quietStartup": True, "enableInstallTelemetry": False,
        "theme": "dark", "compaction": {"enabled": False}, "retry": {"enabled": False}}))
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "TERM": "xterm-256color", "LANG": "C.UTF-8",
        "PI_CODING_AGENT_DIR": str(agent), "PI_SDK_DIR": str(sdk), "PI_OFFLINE": "1", "PI_TELEMETRY": "0",
        "PI_SKIP_VERSION_CHECK": "1", "SWARM_DASHBOARD_FIXTURE": "1"}
    command = ["node", "--experimental-import-meta-resolve", "--import", str(HERE.parent / "sdk-register.mjs"),
        str(cli), "--no-extensions", "-e", str(HERE / "dashboard-fixture.ts"), "--no-skills",
        "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-tools"]
    return command, project, env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tmux", metavar="SESSION")
    args = parser.parse_args()
    sdk, cli = pi_package_dir(), pi_cli()
    with DisposableFixture() as fixture:
        command, project, env = setup(fixture.root, sdk, cli)
        terminal = TmuxTerminal(command, project, env, args.tmux) if args.tmux else Terminal(command, project, env)
        fixture.terminal = terminal
        try:
            if args.tmux:
                terminal.resize(100, 40)
            exercise(terminal)
            print("PASS: static offline dashboard Alt+N transport, roster/detail, history end, search/help/topics, close/reopen, running/paused/stopped/unattached, 40x16 resize; " + ("detached tmux" if args.tmux else "PTY"))
        finally:
            terminal.close()


if __name__ == "__main__":
    main()
