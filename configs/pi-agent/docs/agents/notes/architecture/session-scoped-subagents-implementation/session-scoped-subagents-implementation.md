# Session-scoped Pi Subagents implementation

Implemented: 2026-07-13

Current contract refreshed: 2026-07-28

## Delivered

- Mutable registries, mailboxes, archives, open-task anchors, and agent sessions are scoped beneath the stable owning main Pi session ID.
- Reload/resume restores the same scope; `/new`, fork, and another main session start separate scopes.
- No-address `subagent_status` exposes a stable opaque `ownerScopeId` fingerprint so workflows can verify scope continuity without publishing the raw session ID.
- Persistent typed agents are get-or-create within one owner scope. One-shot agents auto-retire after their final report.
- The main agent is the only coordinator; ordinary subagents cannot spawn or message peers.
- `subagent_spawn` and `subagent_send` expose assignment anchors.
- `subagent_await` accepts exact `{to, anchorId}` targets, `all`/`any` mode, and an optional timeout.
- Await returns top-level `completed`, `timeout`, or `empty`; per-target outcomes are `completed`, `error`, or `retired`.
- Questions use a completed final waiting/blocked report. The main agent answers with a new `subagent_send` and awaits its new envelope ID.
- Host ownership uses a scoped lease and process identity to prevent two active processes from owning one persisted main-session scope.
- The project session tree is a non-overridable sandbox denial.

## Verification

`configs/pi-agent/packages/pi-subagents/test/e2e/run.sh` runs:

- strict TypeScript checking;
- data-layer, definition, spawn, await, wake, control, resume, sandbox, TUI, and loader harnesses;
- resume-stable and cross-session-distinct owner-scope fingerprint checks.

The await harness covers final reports, timeouts, errors, retirement, multiple targets, and open-task cleanup. Session tests cover host ownership and persistent memory across resume.

## Operating rules

- Capture and await the exact assignment anchor when a delegated result is required.
- Treat timeout as pending and `error`/`retired` as non-completion.
- Never assume a deterministic agent address in another main session identifies the same memory; compare `ownerScopeId` first.
- Do not silently recreate a missing persistent agent when workflow continuity depends on its prior context.
- Run `/reload` or restart Pi after changing extension code, type definitions, or skills.
