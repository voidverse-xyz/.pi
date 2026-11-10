"""Deterministic cleanup failure regressions; no Pi CLI or provider required."""
import os
import shutil
import signal
import subprocess
import unittest
from unittest.mock import Mock, patch

from run import DisposableFixture, Terminal


class CleanupTests(unittest.TestCase):
    def terminal(self):
        terminal = Terminal.__new__(Terminal)
        terminal.fd, self.writer = os.pipe()
        self.addCleanup(os.close, self.writer)
        terminal.process = Mock(pid=12345)
        terminal.send = Mock(side_effect=OSError("PTY closed"))
        return terminal

    def test_write_failure_and_term_timeout_escalate_and_reap(self):
        terminal = self.terminal()
        fd = terminal.fd
        terminal.process.poll.side_effect = [None, None, None]
        terminal.process.wait.side_effect = [subprocess.TimeoutExpired("child", 1), -9]
        with patch("run.os.killpg") as kill:
            terminal.close(term_timeout=0, kill_timeout=0)
        self.assertEqual(kill.call_args_list, [unittest.mock.call(12345, signal.SIGTERM),
                                              unittest.mock.call(12345, signal.SIGKILL)])
        self.assertEqual(terminal.process.wait.call_count, 2)
        with self.assertRaises(OSError):
            os.fstat(fd)

    def test_exit_signal_race_still_waits(self):
        terminal = self.terminal()
        terminal.process.poll.side_effect = [None, None, 0]
        with patch("run.os.killpg", side_effect=ProcessLookupError):
            terminal.close()
        terminal.process.wait.assert_called_once()
        self.assertIsNone(terminal.fd)

    def test_unconfirmed_exit_preserves_files_and_closes_fd(self):
        fixture = DisposableFixture().__enter__()
        self.addCleanup(shutil.rmtree, fixture.root)
        evidence = fixture.root / "evidence"
        evidence.write_text("retain")
        terminal = fixture.terminal = self.terminal()
        terminal.process.poll.return_value = None
        terminal.process.wait.side_effect = subprocess.TimeoutExpired("child", 1)
        with patch("run.os.killpg"), self.assertRaisesRegex(RuntimeError, "unconfirmed"):
            terminal.close(term_timeout=0, kill_timeout=0)
        self.assertIsNone(terminal.fd)
        with self.assertRaisesRegex(RuntimeError, "unconfirmed"):
            fixture.__exit__(None, None, None)
        self.assertEqual(evidence.read_text(), "retain")

    def test_confirmed_exit_removes_fixture(self):
        with DisposableFixture() as fixture:
            root = fixture.root
            fixture.terminal = Mock()
            fixture.terminal.process.poll.return_value = 0
        self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
