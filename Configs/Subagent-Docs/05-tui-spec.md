# TUI Spec — Subagent Visibility & Control

Decided 2026-07-09 (D8, D17, D22). Four components. All rendering uses Pi's own
transcript components where sessions are shown (D7).

## 1. Ambient widget (main session footer)

```
⚒ 2 running · 1 waiting · 📬 3 · ⏸ budget 12/40
```
- Segments appear only when non-zero: running count · waiting (agents blocked on a
  human escalation — the needs-eyes state) · unread queued reports (D16 quiet mail)
  · autonomy budget (shown once >50% consumed; becomes a ⏸ paused banner when a
  D21 rail trips, with queued-mail count).
- Zero agents → widget hidden. The extension is silent when unused.
- Impl note: no-nested-SGR constraint applies to colored segments.

## 2. Picker — /subagents (overlay)

- Rows grouped by team, then (solo). Per row: state glyph (● running / ◐ queued /
  ○ dormant / ⚠ waiting), address, ctx%, unread badge.
- Collapsed `▸ .archive (n)` section at bottom — retired oneshots viewable until GC
  (D13 post-mortem promise).
- Keys: ↑↓ navigate · Enter view · x interrupt · X retire (confirm dialog) · Esc.
- /subagents <type>/<id> jumps straight to the viewer (D17).

## 3. Viewer (full-screen session view)

- Header strip: `refactorer/auth · billing-refactor · running · ctx 61% · 142k ·
  $0.84 · ↻9`.
- Transcript: Pi's own components; replay JSONL then live-tail. Envelope traffic
  renders as distinct compact entries (📨 → refactorer/api: question "...") so
  inter-agent chatter is visually separate from tool work.
- Input line: superuser messaging (D17; FYI report to main agent on every send).
  Enter = normal mail (turn-boundary delivery) · alt+Enter = steer (immediate
  injection) — the keyboard mirrors the send/steer tool split (D11/D16).
- Keys: Esc back · ctrl+j next agent (global quick-switch too: main → agents →
  main) · x interrupt.
- Impl note: pi-tui Editor onSubmit-after-onChange("") quirk applies to the input
  line (re-apply submitted text).

## 4. Escalation prompt (modal — the D10 human gate)

```
⚠ refactorer/auth requests approval
  bash: git push origin main
  blocked by: writePaths (mutation outside src/auth/**)
  [a]pprove once  [d]eny  [D]eny with note  [v]iew session
```
- Surfaces immediately when the user is present; otherwise queues behind the
  widget's ⚠ segment.
- Pending agent sits in `waiting` — its turn awaits the tool result (clean async
  pause in-process; no teardown).
- Deny → tool-error the agent can react to; deny-with-note redirects it in the
  same action.
- APPROVE-ONCE ONLY — deliberately no "approve for session"/"always allow":
  session-wide grants would recreate the runtime-permission creep D10's static
  policy exists to prevent. The durable fix for repeat escalations is editing the
  type's frontmatter (auditable, on disk).
