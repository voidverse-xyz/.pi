# TUI Spec — Subagent Visibility & Control

> **Historical — superseded.** This TUI specification describes retired controls and states. Use the current package README, implementation, and `03-tool-surface.md`.

Decided 2026-07-09 (D8, D17, D22). Four components. All rendering uses Pi's own
transcript components where sessions are shown (D7).

## 1. Ambient widget (main session footer)

```
󰚩 2 running · 1 waiting · 󰇮 3 · 󰔛 budget 12/40
```
- Nerd Font icons: `󰚩` agents, `󰇮` queued mail, and `󰔛` threshold consumption.
  The timer-sand is informational, never a paused state.
- Segments appear only when non-zero: running count · waiting (agents blocked on a
  human escalation — the needs-eyes state) · unread queued reports · session
  threshold use (shown once >50% consumed).
- Zero agents → widget hidden. The extension is silent when unused.
- Impl note: no-nested-SGR constraint applies to colored segments.

### Threshold-warning widget (persistent, non-blocking)

```
⚠ Subagent limit warning — refactorer/auth
maxTurnMinutes: 15/15 minutes. The agent is still running.
alt+ctrl+x interrupt only this subagent turn · alt+ctrl+i ignore
```

Crossing session or per-agent token/time/compaction thresholds adds one warning
card above the working area without capturing the editor. `alt+ctrl+x` interrupts
only the named subagent's current turn and cancels that task anchor; it never
aborts main or peers. `alt+ctrl+i` dismisses the card and execution continues.
Multiple warnings queue and are shown one at a time.

## 2. Picker — /agents (overlay)

- Rows grouped by team, then (solo). Per row: Nerd Font state glyph (`` running /
  `` queued / `` dormant / `` waiting), address, ctx%, unread badge.
- Collapsed `▸ .archive (n)` section at bottom — retired oneshots viewable until GC
  (D13 post-mortem promise).
- Keys: ↑↓ navigate · Enter view · x interrupt · X retire (confirm dialog) · Esc.
- /agents <type>/<id> jumps straight to the viewer (D17).
- Roster/archive/mail are for the current owning main session only (D25).
- `/agents adopt-legacy` confirms assignment of inactive cwd-wide state into an
  empty persisted current scope; `/agents rollback-legacy` restores its backup
  only before fingerprinted state diverges. Both are human-only, never LLM tools.

## 3. Viewer (full-screen session view)

- Header strip: `refactorer/auth · billing-refactor · running · ctx 61% · 142k ·
  $0.84 ·  9` (Nerd Font history icon = accumulated turns).
- Transcript: Pi's own components; replay JSONL then live-tail. Envelope traffic
  renders as distinct compact entries (`󰇮` → refactorer/api: question "...") so
  inter-agent chatter is visually separate from tool work.
- Input line: superuser messaging (D17; FYI report to main agent on every send).
  Enter = normal mail (turn-boundary delivery) · alt+Enter = steer (immediate
  injection) — the keyboard mirrors the send/steer tool split (D11/D16).
- Keys: Esc back · alt+j next agent (global quick-switch too: main → agents →
  main) · x interrupt.
- Impl note: pi-tui Editor onSubmit-after-onChange("") quirk applies to the input
  line (re-apply submitted text).

## 4. Escalation prompt (modal — the D10 human gate)

```
 refactorer/auth requests approval
  bash: git push origin main
  blocked by: writePaths (mutation outside src/auth/**)
  [a]pprove once  [d]eny  [D]eny with note  [v]iew session
```
- Surfaces immediately when the user is present; otherwise queues behind the
  widget's `` waiting state.
- Pending agent sits in `waiting` — its turn awaits the tool result (clean async
  pause in-process; no teardown).
- Deny → tool-error the agent can react to; deny-with-note redirects it in the
  same action.
- APPROVE-ONCE ONLY — deliberately no "approve for session"/"always allow":
  session-wide grants would recreate the runtime-permission creep D10's static
  policy exists to prevent. The durable fix for repeat escalations is editing the
  type's frontmatter (auditable, on disk).
