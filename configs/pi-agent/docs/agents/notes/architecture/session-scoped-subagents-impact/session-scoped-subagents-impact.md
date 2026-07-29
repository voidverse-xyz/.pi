# Session-scoped subagents: impact and breaking-change assessment

> **Historical pre-implementation analysis — superseded.** The architecture and command proposals below are archival. Use `configs/subagent-docs/03-tool-surface.md` and the current implementation note for active behavior.

Date: 2026-07-12
Status: analysis only; no implementation decision
Follow-up plan: `configs/pi-agent/docs/agents/plans/architecture/session-scoped-subagents-and-reliable-results/session-scoped-subagents-and-reliable-results.md`

## Executive conclusion

The session-owned model is architecturally sound **if the intended invariant is that one Pi conversation owns its workers**. It prevents different Pi sessions in the same cwd from sharing a roster, waking or retiring each other's agents, consuming each other's mail, and surfacing each other's escalations.

It is not a mailbox-only patch. The current package deliberately implements D3's opposite invariant: every main Pi session in one cwd shares the same registry, identities, teams, mailboxes, archives, and persistent agent memory. Converting that design is a moderate, intentionally breaking storage and procedure change.

Recommendation: implement only after accepting the behavioral breaks below and settling fork, ephemeral-session, and legacy-adoption policy. For a production-safe conversion with migration and concurrency coverage, budget roughly **6–10 engineer-days**. A clean-break MVP without legacy adoption could be **3–5 days**, but risks making existing agents appear lost.

## Current architecture

`store/layout.ts:createLayout(cwd, options)` derives one mutable state root from cwd:

```text
~/.pi/agent/sessions/<cwd-slug>/subagents-<cwd-digest>/
  registry.json
  teams.json
  .main/{mailbox,escalations,auto-wake-blocked}
  .archive/
  <type>/<id>/{session JSONL,mailbox,files}
```

Consequences:

- `core.ts:createCore()` and the abort-latch, reconciliation, and GC helpers take cwd, not a main session ID.
- `index.ts:session_start` tears down and recreates a core for startup, reload, new, resume, and fork, but every core reopens the same cwd root.
- `runtime/in-process.ts` has per-agent cross-process run-owner markers, so two processes should not append the same subagent JSONL simultaneously. There is no equivalent ownership boundary for the whole main-session system or an atomic main-mail digest claim.
- `00-design-log.md` D3 explicitly promises that every main session in a cwd sees the same persistent agents. Session ownership would supersede D3 rather than merely fix an implementation defect.

Pi exposes the correct identity through `ctx.sessionManager.getSessionId()`. It is stable across reload and resume, and new for `/new` and `/fork`. The session ID is preferable to the session filename, which can be absent for non-persisted sessions.

## Recommended target model

Use a versioned project container with one mutable owner root per main Pi session:

```text
~/.pi/agent/sessions/<cwd-slug>/subagents-by-main-session-<cwd-digest>/
  owners/<main-session-id>/
    scope.json
    registry.json
    teams.json
    .main/{mailbox,escalations,auto-wake-blocked}
    .archive/
    <type>/<id>/{session JSONL,mailbox,files}
```

`scope.json` should record the schema version, canonical cwd, owning main session ID, creation time, and migration provenance.

Keep project resources shared and unchanged:

- global and project subagent type definitions;
- global and project `subagents.json` settings;
- cwd and project context loading;
- the model registry and trust decision.

The sandbox must deny the **entire project container**, not only the active owner root. Otherwise an agent in one session could mutate a sibling session's state.

### Resulting lifecycle

- `/reload`: same session ID, same agents.
- `/resume`: same session ID, same agents and pending mail.
- `/new`: new session ID, empty agent system.
- `/fork` and `/clone`: new session ID, empty agent system unless a future explicit adoption/clone operation is added.
- Two different sessions in the same cwd: isolated.
- Two terminals opening the **same** Pi session: still require a host-scope lease or atomic ownership mechanism; session scoping alone does not solve that case.

## Breaking changes

### 1. Project-wide persistent identities disappear

Today `<type>/<id>` is unique within the cwd. Afterward it is unique only within one main session. Two sessions may each have `reviewer/auth` with unrelated memory.

Impact:

- `subagent_spawn` in one session will no longer wake an agent created by another.
- `subagent_status`, `/agents`, `alt+j`, interrupt, steer, collect, and retire will see/control only the current session's agents.
- Reports and archived records that show only `<type>/<id>` are ambiguous outside their owning session. Disk paths and archive metadata must include the owner session ID.

The seven public tool schemas can remain unchanged because the current session supplies the implicit namespace. This is a semantic break, not necessarily a JSON-schema break.

### 2. `/new` no longer carries workers forward

This is intentional but breaks the current D3 procedure. Users who use `/new` to clear conversation context while retaining the same project worker pool will instead receive an empty roster.

### 3. Forked conversation history references agents that do not exist

A fork inherits conversation history and therefore may contain earlier `subagent_spawn`, status, and mail results. An isolated fork will not inherit the referenced agents. The forked LLM may try to message them and receive “never spawned.”

Minimum safe behavior: inject a visible/system context note on `session_start(reason: "fork")` stating that subagents were not inherited. True fork adoption or cloning is a separate feature and substantially more expensive because active agent state, mail, teams, collects, and transcripts must be snapshotted consistently.

### 4. Existing cwd-wide state has no deterministic owner

The legacy registry does not record which historical main session owns it because all sessions intentionally shared it. Automatic “first session wins” migration is nondeterministic and dangerous when two terminals are open.

Existing registry, teams, agents, mailboxes, collect indexes, pending main mail, escalations, and archives must move as one unit. Copying is unsafe because it duplicates pending mail and creates two live identities from one transcript.

### 5. Ephemeral main sessions need a policy

`getSessionId()` exists for non-persisted sessions, but that session cannot later be resumed. Persistently storing agents beneath that ID would create unreachable state.

Recommended policy: allow process-lifetime/oneshot agents in ephemeral sessions, but reject persistent spawns with a clear error. A persistent ephemeral scope would otherwise require a separate user-visible recovery handle.

### 6. Same-session multi-terminal concurrency remains

Two terminals can resume the same session ID and therefore share the same new owner root. Current per-agent `.run-owner.json` protection should remain, but the main mailbox still needs an atomic claim and the whole scope should have a host-runtime lease. Without that, both processes may compose the same pending digest or one startup may reconcile another process's in-flight delivery.

### 7. Archives and GC become multi-scope

The current GC scans one registry, one main mailbox, one escalation directory, and one archive. The new implementation must either:

- GC only the active scope and accept stale scopes, or
- enumerate owner scopes safely and apply retention without treating a live foreign scope as crashed.

A central project-wide archive viewer would be an additional feature; the simplest initial behavior is current-session archives only.

### 8. Autonomy-budget restoration is a separate choice

The autonomy pool is already an in-memory object per core, so different live cores have separate budgets today. It resets on reload/process replacement. Session scoping does not require persistence, but “resume restores the exact budget/pause state” would require a new locked state file and additional recovery logic.

## Code impact

### Primary production changes

1. `extensions/subagents/store/layout.ts`
   - Split project layout from owner-session layout.
   - Require and validate a main session ID.
   - Add project container, owner root, scope manifest, and legacy-root paths.
   - Rebase registry, teams, main mailbox, escalations, archive, agent directories, and lifecycle lock on the owner root.

2. `extensions/subagents/core.ts`
   - Add `ownerSessionId` to `CreateCoreOptions`.
   - Pass session identity to `createLayout`.
   - Change abort-latch, GC, and main-mail reconciliation helpers from cwd-only to owner-aware.
   - Replace the current automatic legacy-root rename with explicit migration/adoption logic.

3. `extensions/subagents/index.ts`
   - Capture `ctx.sessionManager.getSessionId()` on every session start and tool context.
   - Bind lazy core creation, latch handling, reconciliation, GC, and widgets to that ID.
   - Handle startup/reload/resume/new/fork semantics explicitly.
   - Add fork isolation notice and ephemeral-session behavior.

4. `extensions/subagents/runtime/in-process.ts`
   - Protect the entire project container in `_policyFor()`.
   - Retain per-agent run ownership as defense for the same-session/two-terminal case.
   - Potentially add scope-host ownership and durable autonomy state.

5. `extensions/subagents/mail/mailbox.ts` and `core.ts:drainMainMail`
   - Make main-mail claiming atomic before digest composition, or guard it with a scope-host lease.
   - Ensure reconciliation is local to the owning scope/session.

6. `extensions/subagents/store/archive.ts`
   - Adapt GC to owner scopes and migration backups.
   - Decide whether archives remain per scope or are centrally indexed with owner tags.

7. `extensions/subagents/tools/main-agent.ts` and TUI files
   - Tool schemas need not change.
   - Descriptions, picker labels, archive provenance, and errors should clarify “current Pi session.”

### Tests requiring updates or additions

All harnesses that construct layouts/cores need fixed session IDs. The most affected are:

- `phase1-data-layer.mjs`: owner-root derivation, ID validation, two sessions in one cwd, legacy detection.
- `phase2-runtime.mjs`: same address isolated across sessions; resume sees same memory.
- `phase3-mail.mjs`: reports route only to the owning main mailbox.
- `phase4-teams-rails.mjs`: teams and peer ACLs are scope-local.
- `phase5-sandbox.mjs`: sibling owner roots and legacy backups are hard-denied.
- `phase6-tui.mjs`: current-session roster/archive labeling.
- `phase7-full-story.mjs`: new/resume/fork lifecycle story.
- `phase-lifecycle-fixes.mjs`: retirement and escalation recovery remain owner-local.
- `phase-runtime-fixes.mjs`: same-session two-process lease/claim, cross-session no-reconciliation, crash-before-host-append.
- Extension context stubs must implement `sessionManager.getSessionId()` and, for ephemeral cases, `isPersisted()`.

The current suite has about 10.7k production TypeScript lines and 6.4k harness lines. The path abstraction limits the production churn, but persistence and race tests dominate the cost.

## Migration recommendation

Use an explicit human-only `/agents adopt-legacy` flow:

1. Detect the old cwd-wide root but do not auto-open or drain it.
2. Require an empty destination scope.
3. Refuse while any live foreign run-owner exists; instruct the user to close other Pi processes in that cwd.
4. Acquire a project migration lock.
5. Move the complete legacy state into the current session's owner root atomically where possible.
6. Write a migration ledger and retain a rollback marker/backup policy.
7. Reconcile the adopted main mailbox against the selected session only after adoption.

Do not expose adoption as an LLM tool. Ownership of historical state is a human decision.

## Effort estimate

| Scope | Estimate |
|---|---:|
| Layout split, session binding, basic isolation | 2–3 days |
| Main-mail atomic claim / scope host lease | 1–2 days |
| Explicit legacy adoption and rollback safety | 1–2 days |
| Lifecycle, sandbox, archive/GC, docs | 1–2 days |
| Full harness updates and concurrent-session cases | 1–2 days |
| **Production-safe total** | **6–10 days** |

Optional additions:

- Fork agent cloning/adoption: **+3–5 days**.
- Durable autonomy counters across reload/resume: **+1–2 days**.
- Project-wide cross-session roster/archive browser: **+1–2 days**.

A clean-break implementation that leaves old state untouched and omits migration/host-lease hardening may fit in **3–5 days**, but it does not fully solve concurrency and has poor upgrade UX.

## Decision gates before implementation

1. Is the intended identity boundary definitively “one main Pi conversation,” even though this supersedes D3?
2. Is an empty fork acceptable if the forked transcript references non-inherited agents?
3. Should persistent agents be rejected in `--no-session` mode?
4. Must autonomy usage survive reload/resume, or may it reset as today?
5. Is explicit human adoption of legacy state acceptable?
6. Should opening the same Pi session in two terminals be rejected/leased, or merely best-effort?

## Go/no-go recommendation

**Go** if simultaneous independent Pi conversations in one cwd are a normal procedure and workers should belong to their conversation. The change produces a much clearer ownership model and removes cross-session control/mail ambiguity.

**Do not do the full conversion** if the desired product is a project-wide worker pool shared across conversations. In that case preserve D3 and instead add an atomic main-mail claim plus explicit main-session routing/host ownership. That narrower path is cheaper and retains existing persistent-agent behavior.
