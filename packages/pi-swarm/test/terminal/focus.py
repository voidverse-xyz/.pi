#!/usr/bin/env python3
"""Exercise actual Swarm focus bridge with an offline plain-data presenter.
Optional --reference FILE --source subagents|teams loads a READ-ONLY reference
focus producer with an inert core; not a Swarm runtime dependency. --tmux SESSION
creates a detached window only. --captures DIR saves sanitized screen comparisons.
Requires installed Pi/Node/Python, POSIX; tmux required for screen captures.
"""
import argparse
import json
import subprocess
import time
from pathlib import Path

from dashboard import TmuxTerminal, setup
from run import DisposableFixture, HERE, Terminal, pi_cli, pi_package_dir


def expect_focus(terminal, args, position):
    label = f"[{position}/2] Swarm" if args.source == "swarm" else ["Alpha implementation", "Beta review"][position - 1]
    terminal.expect(label)
    if args.source == "swarm" and args.tmux:
        screen = subprocess.check_output(["tmux", "capture-pane", "-p", "-t", terminal.window], text=True)
        assert "Message agent" not in screen and "Agent conversation" not in screen, "Alt+N opens general Messages without composer"
        assert "╭ Messages" in screen, "initial page is the general overview"


def open_worker(terminal, worker, composer=False):
    terminal.send("4" if composer else "2")
    terminal.expect(f"> {worker}")
    terminal.send("\r")
    terminal.expect("Steer · native Pi transcript" if composer else "Agent conversation")
    if composer:
        if isinstance(terminal, Terminal):
            terminal.cursor = terminal.last_expect_start  # Conversation and editor arrive in one redraw.
        terminal.expect("Message agent")


def capture_sizes(terminal, args, page, composing=False):
    for width, rows in [(100, 40), (60, 24), (40, 16), (30, 9), (12, 6)]:
        terminal.resize(width, rows)
        # Pump PTY output through resize; tmux captures are real rendered screens.
        if not args.tmux:
            for _ in range(5):
                terminal.pump(0.1)
        else:
            time.sleep(0.3)
            screen = subprocess.check_output(["tmux", "capture-pane", "-p", "-t", terminal.window], text=True)
            lines = screen.splitlines()
            assert len(lines) == rows, "focus surface must occupy the full viewport"
            if width >= 16 and rows >= (15 if composing else 10):
                top = 3 if args.source == "swarm" else 2
                bottom = next(i for i, line in enumerate(lines) if line.startswith("╰")) if composing else rows - 2 if args.source == "swarm" else rows - 6
                assert lines[top].startswith("╭") and lines[top].endswith("╮"), "rounded frame top"
                assert lines[bottom].startswith("╰") and lines[bottom].endswith("╯"), "rounded frame bottom"
                assert all(line.startswith("│ ") and line.endswith(" │") for line in lines[top + 1:bottom]), "padded frame sides"
            if args.captures:
                target = Path(args.captures)
                target.mkdir(parents=True, exist_ok=True)
                (target / f"{page}-{width}x{rows}.txt").write_text(screen, encoding="utf-8")
                # tmux -e preserves trusted SGR styles for the owner's theme inspection.
                colored = subprocess.check_output(["tmux", "capture-pane", "-p", "-e", "-t", terminal.window], text=True)
                (target / f"{page}-{width}x{rows}.ansi").write_text(colored, encoding="utf-8")
    terminal.resize(100, 40)


def exercise(terminal, args):
    terminal.expect("Actual focus fixture ready")
    terminal.send("\x1bn")
    expect_focus(terminal, args, 1)
    capture_sizes(terminal, args, "swarm-overview" if args.source == "swarm" else args.source)
    if args.composer:
        open_worker(terminal, "alpha", composer=True)
        capture_sizes(terminal, args, "swarm-agent", composing=True)
        terminal.send("\t")
        terminal.expect("╭ Steer")
        for key, caption in [("1", "╭ Messages"), ("3", "╭ Topics")]:
            terminal.send(key)
            terminal.expect(caption)
            if args.tmux:
                screen = subprocess.check_output(["tmux", "capture-pane", "-p", "-t", terminal.window], text=True)
                assert "Message agent" not in screen and "Enter send" not in screen, "tabs remain inspection-only"
        open_worker(terminal, "alpha", composer=True)
        terminal.send("Fixture composed mail")
        terminal.send("\r")
        terminal.expect("Message queued to alpha")
        terminal.send("Retained alpha draft")
        terminal.send("\x1bn")
        expect_focus(terminal, args, 2)
        open_worker(terminal, "beta", composer=True)
        terminal.send("Retained beta draft")
        terminal.send("\x1bn")
        expect_focus(terminal, args, 1)
        open_worker(terminal, "alpha", composer=True)
        if not args.tmux:
            terminal.cursor = terminal.last_expect_start  # Label and retained draft may share one redraw.
        terminal.expect("Retained alpha draft")
        terminal.send("\x1b")
        terminal.expect("Fixture main-1")
        terminal.send("\x1bn")
        expect_focus(terminal, args, 1)
        terminal.send("\x1b")
        terminal.expect("Fixture main-2")
        return
    if args.source == "swarm":
        terminal.send("2")
        terminal.expect("> alpha")
        terminal.send("j")
        terminal.expect("> beta")
        terminal.send("\r")
        terminal.expect("Agent conversation")
        terminal.send("\x1bn")
        expect_focus(terminal, args, 1)
    terminal.send("\x1bn")
    expect_focus(terminal, args, 2)
    terminal.send("\x1b")
    terminal.expect("Fixture main-1")
    terminal.send("\x1bn")
    expect_focus(terminal, args, 1)
    terminal.send("\x1b")
    terminal.expect("Fixture main-2")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tmux", metavar="SESSION")
    parser.add_argument("--captures", metavar="DIR")
    parser.add_argument("--composer", action="store_true", help="Exercise native Swarm editor with local fixture mail only")
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--source", choices=["swarm", "subagents", "teams"], default="swarm")
    args = parser.parse_args()
    if args.composer and (args.reference or args.source != "swarm"):
        parser.error("composer acceptance requires the Swarm producer")
    if args.reference and args.source == "swarm":
        parser.error("reference requires --source subagents or teams")
    sdk, cli = pi_package_dir(), pi_cli()
    with DisposableFixture() as fixture:
        command, project, env = setup(fixture.root, sdk, cli)
        command[command.index(str(HERE / "dashboard-fixture.ts"))] = str(HERE / "focus-fixture.ts")
        env["SWARM_FOCUS_FIXTURE"] = "1"
        env["SWARM_FOCUS_SOURCE"] = args.source
        if args.composer:
            env["SWARM_FOCUS_COMPOSER"] = "1"
        if args.reference:
            env["SWARM_FOCUS_REFERENCE"] = args.reference.resolve().as_uri()
        session = fixture.root / "fixture-session.jsonl"
        entries = [
            {"type": "session", "version": 3, "id": "fixture", "timestamp": "2026-01-01T00:00:00Z", "cwd": str(project)},
            {"type": "message", "id": "message", "parentId": None, "timestamp": "2026-01-01T00:00:01Z",
             "message": {"role": "user", "content": "Fixture message 界🙂", "timestamp": 1}},
        ]
        session.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")
        env["SWARM_FOCUS_SESSION"] = str(session)
        terminal = TmuxTerminal(command, project, env, args.tmux) if args.tmux else Terminal(command, project, env)
        fixture.terminal = terminal
        try:
            if args.tmux:
                terminal.resize(100, 40)
            exercise(terminal, args)
            print(f"PASS: actual {args.source} focus producer, presenter Alt+N open/next, Escape main/reopen, 100x40/60x24/40x16/30x9/12x6 resize" + ("; tmux captures" if args.tmux else "; PTY"))
        finally:
            terminal.close()


if __name__ == "__main__":
    main()
