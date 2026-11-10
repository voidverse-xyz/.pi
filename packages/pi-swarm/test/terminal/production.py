#!/usr/bin/env python3
"""Real CLI/PTY acceptance with production Plan/Safety and offline scripted SDK workers.
Uses the existing bounded child cleanup guard; no installs, keys, or global activation.
"""
import json
import os
import shutil
import subprocess
import time

from run import ANSI, HERE, DisposableFixture, Terminal, compact, pi_cli, pi_package_dir


def main(native=False):
    # Resolve before PI_CODING_AGENT_DIR is swapped for the disposable one below.
    pi, sdk = pi_cli(), pi_package_dir()
    assert shutil.which("node") and shutil.which("git"), "node and git required"
    with DisposableFixture() as fixture:
        root = fixture.root
        home, agent, project = [root / name for name in ("home", "agent", "project")]
        for path in (home, agent, project):
            path.mkdir(mode=0o700)
        event_file = root / "events.jsonl"
        env = {"PATH": os.environ["PATH"], "HOME": str(home), "TERM": "xterm-256color",
               "LANG": "C.UTF-8", "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1",
               "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1", "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_CONFIG_GLOBAL": os.devnull, "SWARM_TERMINAL_FIXTURE": str(event_file)}
        if native:
            env["SWARM_TERMINAL_NATIVE"] = "1"
        label = "Pi native provider" if native else "mock only"
        scope = "Disposable project only; no network"
        env["PI_SDK_DIR"] = str(sdk)  # The child's sdk-register cannot see the real agent dir.
        settings = {"quietStartup": True, "enableInstallTelemetry": False, "tuiMode": "fullscreen", "fullscreenScrollbar": "always",
                    "compaction": {"enabled": False}, "retry": {"enabled": False}}
        (agent / "settings.json").write_text(json.dumps(settings))
        subprocess.run(["git", "init", "-q", str(project)], env=env, check=True)
        (project / ".git" / "info" / "exclude").write_text(".swarms/\n")
        (project / "user.txt").write_text("preserve this work\n")
        command = [shutil.which("node"), "--experimental-import-meta-resolve", "--import",
                   str(HERE.parent / "sdk-register.mjs"), str(pi), "--no-extensions",
                   "-e", str(HERE / "production-fixture.ts"), "--no-skills", "--no-prompt-templates",
                   "--no-themes", "--no-context-files", "--no-approve", "--no-tools",
                   "--provider", "swarm-mock", "--model", "scripted"]
        terminal = fixture.terminal = Terminal(command, project, env)
        terminal.resize(80, 24)

        def events():
            if not event_file.exists():
                return []
            return [json.loads(line) for line in event_file.read_text().splitlines()]

        def wait(predicate, description, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if predicate():
                    return
                terminal.pump()
            raise AssertionError(f"Missing {description}; observations: {events()[-12:]}; terminal tail:\n{ANSI.sub('', terminal.output)[-5000:]}")

        def count(kind):
            return sum(event["type"] == kind for event in events())

        def wait_count(kind, n):
            wait(lambda: count(kind) >= n, f"{kind} x{n}")

        def mode(selected, enforced=None, pending=False):
            def matches():
                snapshots = [event for event in events() if event["type"] == "mode"]
                return snapshots and snapshots[-1]["selectedMode"] == selected and snapshots[-1]["enforcedMode"] == (enforced or selected) and snapshots[-1]["pendingChange"] == pending
            wait(matches, f"mode {selected}/{enforced or selected}, pending={pending}")

        def policy_command(text):
            # Production mode commands have argument completion; first Enter accepts it.
            terminal.line(text)
            terminal.send("\r")

        def status(expected):
            terminal.line("/fixture-swarm status")
            terminal.expect_status(expected, label)

        def start():
            terminal.cursor = len(terminal.output)
            terminal.line(f"/fixture-swarm start Production policy acceptance. Only approved benign commands execute. {scope}.")
            terminal.expect(f"LAUNCH ({label})")
            if native:
                terminal.read_packet(f"LAUNCH ({label})")
                plain = terminal.last_packet
                for value in ("terminal-native", "native-scripted", "openai-responses", "https://native.invalid/v1",
                              "Pi owns credentials", "OAuth, environment and routing", "informational, not pinned",
                              "objective-and-guidance", "host-instructions", "workspace-content", "tool-definitions-and-results",
                              "worker-history", "peer-messages", "compaction-summaries"):
                    assert compact(value) in plain, f"Missing native agreement disclosure: {value}"
                assert count("native-request") == 0, "No native request before agreement"

        def approve(action):
            terminal.expect(f"{action} ({label})")
            terminal.line("start")
            terminal.expect("Fixture chat confirmation applied")

        def resume(script=None):
            if script:
                terminal.line(f"/fixture-script {script}")
                terminal.expect(f"Script armed: {script.split()[0]}")
            terminal.line("/fixture-swarm resume")
            approve("RESUME")

        def pause():
            terminal.line("/fixture-swarm pause")
            time.sleep(0.2)
            status("paused")

        def stable_workers():
            before = count("worker-start")
            deadline = time.monotonic() + 0.8
            while time.monotonic() < deadline:
                terminal.pump(0.1)
            assert count("worker-start") == before, "No automatic Off/reload resume"
            if native:
                assert count("native-request") == before, "No native follow-up after revocation"
                assert count("native-settled") == before, "Every native stream actually drained"

        try:
            terminal.expect("Production policy fixture ready")
            mode("off")
            # Real production serialization: cancel a queued request, then active UI.
            terminal.line("/fixture-queue")
            terminal.expect("queue-0")
            wait_count("probe-request", 3)
            terminal.send("\x1bx")
            wait(lambda: any(e["type"] == "probe-result" and e["index"] == 1 and not e["approved"] for e in events()), "queued cancellation")
            assert "queue-1" not in ANSI.sub("", terminal.output)
            terminal.send("\x1bz")
            terminal.expect("queue-2")
            terminal.send("n")
            wait_count("probe-result", 3)
            assert all(not e["approved"] for e in events() if e["type"] == "probe-result")

            # A restricted selection invalidates the pending chat proposal, not just a stream.
            start()
            terminal.send("\x1b[Z")  # production Shift+Tab: Off -> Discuss
            mode("discuss")
            terminal.line("start")
            # Revocation removes the proposal before consumption; this is absent
            # owner authority, not a fresh proposal's restricted-mode inspection.
            terminal.expect("AUTHORITY")
            assert count("worker-start") == 0
            assert not (project / ".swarms").exists()
            policy_command("/discuss off")
            mode("off")
            start()
            assert count("worker-start") == 0, "No execution before genuine owner input"
            terminal.line("start")
            terminal.expect("Fixture chat confirmation applied")
            wait_count("worker-start", 1)
            status("running")

            # Actual main CLI turns expose selected versus enforced mode until settled.
            terminal.line("Hold an offline main turn")
            wait_count("main-start", 1)
            policy_command("/quick on")
            mode("quick", "off", True)
            wait_count("worker-abort", 1)
            mode("quick")
            status("paused")
            terminal.line("Hold a restricted offline main turn")
            wait_count("main-start", 2)
            policy_command("/quick off")
            mode("off", "quick", True)
            # Must deny continuation while the old restricted turn is still enforced.
            terminal.line("/fixture-swarm resume")
            terminal.expect("MODE_DENIED")
            mode("off")
            stable_workers()
            status("paused")

            # Plan is also authoritative for both continuation operations.
            policy_command("/plan on")
            mode("plan")
            for action in ("resume", "restart"):
                terminal.line(f"/fixture-swarm {action}")
                terminal.expect("MODE_DENIED")
            policy_command("/plan off")
            mode("off")
            stable_workers()

            # Dashboard must disappear before a worker opens the production custom gate.
            resume("approved hold")
            wait_count("worker-held", 1)
            terminal.line("/fixture-swarm dashboard")
            terminal.expect("Swarm · running")
            if native:
                terminal.send("2")
                terminal.expect("working")
                terminal.inspect_conversation()
            terminal.send("\x1bg")
            terminal.expect("phase8-approved")
            before = count("worker-start")
            terminal.send("y")
            wait_count("worker-start", before + 1)  # actual shell/tool returned to the SDK
            pause()

            # Native denial then mode-triggered active-dialog cancellation.
            resume("denied")
            terminal.expect("phase8-denied")
            before = count("worker-start")
            terminal.send("n")
            wait_count("worker-start", before + 1)
            pause()
            resume("cancelled")
            terminal.expect("phase8-cancelled")
            terminal.send("\x1b[Z")
            mode("discuss")
            time.sleep(0.3)
            status("paused")
            policy_command("/discuss off")
            mode("off")
            stable_workers()

            # Streaming reload uses the native /reload implementation, not a fixture event.
            resume()
            terminal.expect_status("running", label)
            terminal.line("/reload")
            terminal.expect("Reloaded keybindings")
            wait_count("start", 2)
            status("paused")
            stable_workers()
            # New instance must have exactly one provider, not accumulated listeners.
            terminal.line("/fixture-queue")
            terminal.expect("queue-0")
            terminal.send("\x1bx")
            terminal.send("\x1bz")
            terminal.expect("queue-2")
            terminal.send("n")
            wait_count("probe-result", 6)

            if native:
                # A controlled shell seam, NOT an uncertain native model stream.
                terminal.line("/fixture-script uncertain")
                terminal.expect("Script armed: uncertain")
                terminal.line("/fixture-swarm restart")
                approve("RESTART")
                terminal.expect("phase8-uncertain")
                terminal.send("y")
                wait_count("uncertain-runner", 1)
                terminal.line("/fixture-swarm reconcile")
                terminal.expect(f"RECONCILE ({label})")
                terminal.read_packet(f"RECONCILE ({label})")
                recovery_packet = terminal.last_packet
                for value in ('"operations"', '"turns"', '"liveUncertainIds"'):
                    assert value in recovery_packet
                terminal.line("I confirm settlement: Fixture runner spawned no process; its promise returned unsettled by design.")
                terminal.expect("Fixture chat confirmation applied")
                evidence_packet = compact(ANSI.sub("", terminal.output))
                time.sleep(0.4)
                status("paused")
                stable_workers()

            # Shutdown with a real worker awaiting native confirmation cancels it.
            resume("shutdown")
            terminal.expect("phase8-shutdown")
            # Native CLI SIGTERM path owns shutdown, including actual socket settlement.
            terminal.process.terminate()
            wait(lambda: terminal.process.poll() is not None, "graceful CLI shutdown")
            assert terminal.process.returncode == 0
            assert (project / "user.txt").read_text() == "preserve this work\n"
            actual_settings = json.loads((agent / "settings.json").read_text())
            assert isinstance(actual_settings.pop("lastChangelogVersion", None), str)
            assert actual_settings == settings, "Only native changelog bookkeeping may change fixture settings"
            if (agent / "auth.json").exists():
                assert json.loads((agent / "auth.json").read_text()) == {}, "No provider credentials in fixture"
            assert not (home / ".pi").exists()
            observations = events()
            assert "queue-1" not in ANSI.sub("", terminal.output), "Cancelled queued request opened UI"
            assert all(e["active"] == 1 for e in observations if e["type"] == "dialog-open"), "Native dialogs overlapped"
            assert all(e["activeDialogs"] == 0 for e in observations if e["type"] == "shutdown")
            assert [e["reason"] for e in observations if e["type"] == "shutdown"] == ["reload", "quit"]
            journal_path, = (agent / "sessions").glob("*/swarm/*/events.jsonl")
            subprocess.run([shutil.which("node"), str(HERE / "assert-production.mjs"), str(journal_path), str(event_file),
                            *(["native"] if native else [])], env=env, check=True)
            if native:
                subprocess.run([shutil.which("node"), str(HERE / "assert-native.mjs"), str(journal_path), str(event_file)], env=env, check=True)
                journal = [json.loads(line)["payload"] for line in journal_path.read_text().splitlines()]
                operation = next(event["payload"]["id"] for event in journal if event["type"] == "workspace.start" and "uncertain" in event["payload"].get("command", ""))
                assert operation in recovery_packet and operation in evidence_packet, "Exact uncertain intent shown in both decisions"
            audit = [json.loads(line) for line in (agent / "safety-audit.jsonl").read_text().splitlines()]
            assert any(e["decision"] == "approved" for e in audit)
            assert any(e["decision"] == "denied" for e in audit)
            assert "phase8-" not in (agent / "safety-audit.jsonl").read_text(), "Audit must omit arguments"
            print("PASS: owner chat lifecycle consent with no Swarm modals; independent Plan/Safety dialogs, queued/active cancellation, selected/enforced transitions, no auto-resume, offline reload/shutdown, durable command evidence and isolation")
        finally:
            terminal.close()


if __name__ == "__main__":
    main()
