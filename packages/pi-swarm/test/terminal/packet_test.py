"""Deterministic disclosure-harness regressions, no Pi process or provider."""
import unittest
from packet import Viewport, capture_packet, compact, display_match_end, verify_expected, verify_packet, PAGE_UP, BOTTOM

TITLE = "LAUNCH (mock only)"
FOOTER = "Type start to proceed with this Swarm configuration."
IDENTITY = "Proposal ID: current-id (bookkeeping only; not approval)."
BODY = ('Field text is untrusted data Workspace: fixture Mode gate: Off Worker authorization: policy '
        'Preservation: keep Startup fingerprint scope: tracked '
        '"objective" "criteria" "scope" "limits" "agents" "active" "tasks" "attempts" "durationMs" '
        '"codingTools" "instructions" "model" "provider" "thinkingLevel" '
        'Provider agreement Existing changes:')


class PacketTests(unittest.TestCase):
    def test_reconstructs_split_cursor_diff_and_erasure(self):
        screen = Viewport(40, 4)
        screen.feed("\x1b[2J\x1b[HOld approval")
        screen.feed("\x1b[1;")
        screen.feed("1H\x1b[2KCurrent\x1b[2;1Hagreement")
        self.assertIn("Current\nagreement", screen.text())
        self.assertNotIn("Old", screen.text())

    def test_wrapped_complete_configuration_requires_all_pages(self):
        pages = [IDENTITY + FOOTER + "No execution authorized.", BODY,
                 f"Swarm approval packet: {TITLE}"]
        index = [0]
        def page():
            index[0] += 1
        result = capture_packet(TITLE, lambda: pages[index[0]], page, required=(FOOTER,))
        self.assertEqual(index[0], 2)
        self.assertIn(compact(BODY), result)
        self.assertEqual(PAGE_UP, "\x1b[5~")
        self.assertEqual(BOTTOM, "\x1b[1;5F")

    def test_wrapped_paragraph_spanning_overlapping_pages_is_complete(self):
        header = f"Swarm approval packet: {TITLE}"
        pages = ["finish a long paragraph\n" + IDENTITY + FOOTER + "No execution authorized.",
                 "start and\nfinish a long paragraph", header + "\n" + BODY + "\nstart and"]
        index = [0]
        def page():
            index[0] += 1
        result = capture_packet(TITLE, lambda: pages[index[0]], page)
        verify_expected(result, {"proposalId": "current-id", "agreement": "start and finish a long paragraph"})

    def test_transcript_body_excludes_editor_and_jump_chrome(self):
        screen = Viewport(20, 3)
        screen.feed("\x1b[H" + "agreement".ljust(19) + "│\x1b[2;1H" + "editor chrome")
        self.assertEqual(screen.transcript_text(), "agreement")

    def test_jump_overlay_with_a_scrollbar_is_not_transcript_content(self):
        screen = Viewport(80, 3)
        screen.feed("\x1b[H" + "first agreement row".ljust(79) + "│")
        screen.feed("\x1b[2;1H" + "covered ↓ Jump to latest message · Ctrl+End".ljust(79) + "┃")
        screen.feed("\x1b[3;1H" + "last agreement row".ljust(79) + "│")
        self.assertEqual(screen.transcript_text(), "first agreement row\nlast agreement row")

    def test_same_title_stale_header_is_not_current_packet(self):
        pages = [IDENTITY + FOOTER + "No execution authorized.",
                 f"Swarm approval packet: {TITLE}" + BODY +
                 "Proposal ID: previous-id (bookkeeping only; not approval)."]
        index = [0]
        def page():
            index[0] += 1
        with self.assertRaisesRegex(AssertionError, "stale proposal"):
            capture_packet(TITLE, lambda: pages[index[0]], page)

    def test_prior_footer_above_current_header_is_outside_current_packet(self):
        pages = [IDENTITY + FOOTER + "No execution authorized.",
                 "Proposal ID: previous-id (bookkeeping only; not approval).\n"
                 + f"Swarm approval packet: {TITLE}\n" + BODY]
        index = [0]
        def page():
            index[0] += 1
        result = capture_packet(TITLE, lambda: pages[index[0]], page, required=(FOOTER,))
        self.assertNotIn("previous-id", result)
        self.assertIn("current-id", result)

    def test_missing_configuration_blocks_confirmation(self):
        complete = compact(f"Swarm approval packet: {TITLE}" + BODY + IDENTITY + FOOTER + "No execution authorized.")
        for field in ('"instructions"', '"thinkingLevel"', '"durationMs"', "Preservation:"):
            with self.subTest(field=field), self.assertRaisesRegex(AssertionError, "Incomplete agreement"):
                verify_packet(complete.replace(compact(field), ""), TITLE)
        verify_packet(complete, TITLE)

    def test_missing_footer_blocks_confirmation(self):
        with self.assertRaisesRegex(AssertionError, "Incomplete agreement"):
            verify_packet(compact(f"Swarm approval packet: {TITLE}" + BODY + IDENTITY), TITLE, (FOOTER,))

    def test_no_repaint_header_fails_with_bounded_pages(self):
        calls = []
        with self.assertRaisesRegex(AssertionError, "page bound"):
            capture_packet(TITLE, lambda: IDENTITY + FOOTER, lambda: calls.append(PAGE_UP), max_pages=3)
        self.assertEqual(len(calls), 3)

    def test_match_does_not_swallow_safety_prompt_in_same_output_batch(self):
        raw = "Fixture chat \x1b[32mconfirmation applied\x1b[0m\r\nphase8-denied"
        end = display_match_end(raw, "Fixture chat confirmation applied")
        self.assertIsNotNone(end)
        self.assertIn("phase8-denied", raw[end:])
        self.assertIsNotNone(display_match_end(raw[end:], "phase8-denied"))

    def test_key_without_its_expected_configuration_value_does_not_pass(self):
        expected = {"proposalId": "current-id", "agreement": '"agents": 3\n"thinkingLevel": "off"'}
        with self.assertRaisesRegex(AssertionError, "not fully displayed"):
            verify_expected(compact(IDENTITY + '"agents": 4 "thinkingLevel": "off"'), expected)
        verify_expected(compact(IDENTITY + '"agents": 3 "thinkingLevel": "off"'), expected)

    def test_displayed_identity_must_match_newest_original_result(self):
        with self.assertRaisesRegex(AssertionError, "newest original"):
            verify_expected(compact(IDENTITY), {"proposalId": "newest-id", "agreement": BODY})

    def test_missing_identity_does_not_accept_old_visible_header(self):
        with self.assertRaisesRegex(AssertionError, "identity"):
            capture_packet(TITLE, lambda: f"Swarm approval packet: {TITLE}" + BODY, lambda: None)


if __name__ == "__main__":
    unittest.main()
