# Session-scoped subagents and reliable delegated-result delivery

> **Historical implementation plan — superseded.** API shapes and migration proposals below are archival and must not guide current tool calls. Use `configs/subagent-docs/03-tool-surface.md` and the linked implementation note for the active contract.

Status: implemented and independently reviewed (2026-07-13)
Scope selected by user: combined program
Implementation note: `configs/pi-agent/docs/agents/notes/architecture/session-scoped-subagents-implementation/session-scoped-subagents-implementation.md`

## 1. Context and confirmed requirements

The current extension intentionally shares one subagent system across every Pi session in a cwd. That creates ambiguous ownership when two independent Pi conversations are open in the same directory. Separately, delegated reviews can finish after the main agent has already answered because subagent mail is delivered only at a main-turn boundary; interrupting and retiring the reviewer then produces bounce and stale-escalation noise instead of a visible review result.

The implementation must satisfy these requirements:

1. One persisted Pi conversation owns its registry, agents, teams, mailboxes, escalations, archives, and autonomy state.
2. Global/project type definitions, settings, trust, cwd, and project context remain project-scoped.
3. `/reload` and `/resume` restore the same scope; `/new` starts empty; `/fork` and `/clone` start empty and explicitly disclose that agents were not inherited.
4. Different Pi sessions in one cwd cannot see, wake, steer, retire, reconcile, or consume each other's agents or mail.
5. Opening the same persisted Pi session in two terminals cannot create two active host consumers.
6. Existing cwd-wide state is never silently assigned; a human explicitly adopts it into one session.
7. A main agent can wait, cancellably and durably, for a delegated final/collect result without answering the user first.
8. Questions, escalations, and errors from an awaited worker return early to the main agent rather than deadlocking behind the wait.
9. Manual interruption/retirement does not produce a flood of errors for pending messages sent by the same main session; peer questions still receive a bounce.
10. Review procedures do not claim completion until a report is actually received, and the user sees verdict/findings before orchestration details.
11. Every migration, crash window, timeout, cancellation, concurrent-open case, and cleanup path has executable coverage.

## 2. Grounded findings

- `store/layout.ts:createLayout()` currently keys all mutable state only by cwd. `core.ts` passes only cwd to layout, abort-latch, GC, and main-mail reconciliation helpers.
- `index.ts:session_start` recreates the core on startup/reload/new/resume/fork but ignores the host session ID, reopening the same cwd root each time.
- Pi exposes a stable `ctx.sessionManager.getSessionId()` for persisted and ephemeral sessions. Reload/resume retain it; new/fork use a new ID.
- `runtime/in-process.ts` already protects individual agent turns with `.run-owner.json`, but there is no owner lease for the whole main-session scope.
- `core.ts:drainMainMail()` reads pending envelopes before moving them to `.delivering`; two host consumers can compose the same digest before either move wins.
- `subagent_collect` is intentionally non-blocking. Its report cannot enter the current main-agent context until a later turn boundary.
- `mailbox.ts` already has host-delivery parking and JSONL reconciliation. Generalizing that mechanism is safer than inventing a second durability protocol for awaited reports.
- `subagent_spawn` does not expose the task envelope ID; `subagent_send` has an envelope ID internally but omits it from the public tool result.
- Report envelopes do not persist `final:true`; the flag currently only schedules oneshot retirement in memory.
- Retirement intentionally bounces all pending inbound mail. That is correct for peer questions but noisy for messages from the main session that is itself retiring the worker.
- The impact assessment at `configs/pi-agent/docs/agents/notes/architecture/session-scoped-subagents-impact/session-scoped-subagents-impact.md` records the storage and compatibility costs that this plan resolves.

## 3. Chosen design

### 3.1 Split project resources from session-owned state

Adapt the existing `Layout` abstraction rather than threading paths ad hoc.

```text
<pi-project-session-dir>/subagents-by-main-session-<cwd-digest>/
  owners/<main-session-id>/
    scope.json
    .host-owner.json
    autonomy.json
    registry.json
    teams.json
    .main/
      mailbox/
      escalations/
      auto-wake-blocked
    .archive/
    <type>/<id>/
      <subagent-session>.jsonl
      mailbox/
      files/
```

Introduce:

- `ProjectLayout`: canonical cwd, Pi project-session directory, versioned state-container root, legacy roots, type-definition paths, and settings paths.
- `SessionLayout`: validated owner session ID plus every mutable path beneath `owners/<id>`.
- `scope.json`: schema version, canonical cwd, owner session ID, persisted/ephemeral mode, creation time, and optional migration provenance.

The session ID is required in production APIs. Tests pass deterministic IDs; there is no silent `default`/cwd fallback.

Sandbox policy hard-denies the entire versioned project container and every legacy/backup root, not just the active owner directory.

### 3.2 Define lifecycle semantics explicitly

- `startup`/`reload`/`resume`: acquire the same session scope and restore it.
- `new`: create an empty scope.
- `fork`/`clone`: create an empty scope and inject one visible context message: the conversation history was inherited, but its subagents were not; spawn new workers or use a future explicit clone feature.
- Session shutdown: stop new turns, cancel in-memory waits, make agents dormant, release only the current process's host lease, and leave durable mail untouched.
- Ephemeral (`sessionManager.isPersisted() === false`): create an OS-temporary scope, allow only oneshots, reject persistent spawn with a clear error, and remove the temporary scope after bounded shutdown cleanup.
- Autonomy counters/pause state persist in `autonomy.json` under the session scope. User input resets it transactionally. This closes the current reload/restart reset loophole and makes `/resume` honest.

True fork cloning is deliberately out of scope for this program.

### 3.3 Add a host-scope lease

Create `.host-owner.json` with an exclusive-create claim containing PID, random runtime ID, session ID, claimed time, and heartbeat time.

- One live owner may run tools, consume main mail, reconcile delivery, and surface escalations.
- A second process opening the same session enters locked observer mode: it may show a clear warning/read-only status, but mutating subagent tools and auto-wake are disabled.
- Release verifies runtime ID before deletion.
- Reclaim only a dead/stale owner under a cross-process lock.
- Keep per-agent run-owner markers as defense in depth and for recovery during migration.

### 3.4 Make main-mail claiming atomic

Generalize `mailbox.ts` host-delivery machinery into a claim-first protocol:

1. Under a mailbox lock, read and validate eligible pending envelopes.
2. Write delivery metadata and atomically rename the selected files into `.delivering` before composing any digest/tool result.
3. Return the claimed envelopes to the caller.
4. If composition fails before handoff, requeue precisely that claim.
5. Reconciliation finalizes only after the target main-session JSONL contains both the envelope ID and the delivery marker; otherwise crash recovery requeues it as a labeled redelivery.

Delivery metadata records the mode/marker:

- `digest` with marker `subagent-mail`;
- `await-tool-result` with marker `subagent_await`.

This one protocol supports ordinary wake digests and awaited reports without duplicate consumption.

### 3.5 Add durable report anchors and final metadata

Make additive envelope/tool-result changes:

- `EnvelopePayload.final?: boolean`, valid only for `report` envelopes.
- Subagent `report(final:true)` writes `payload.final: true` before scheduling oneshot retirement.
- `subagent_spawn` returns `taskEnvelopeId` when `task` is supplied.
- `subagent_send` returns its existing `envelopeId` publicly.
- Existing `subagent_collect` continues returning `requestId`.

These IDs let the main agent identify the exact delegated run instead of waiting for an ambiguous “next report.”

### 3.6 Add `subagent_await`

Register an eighth main-agent tool:

```text
subagent_await(
  to,
  waitFor: "final" | "collect",
  anchorId,
  timeoutSeconds?
)
```

Semantics:

- `waitFor:"final"`: wait for a `report` from `to` with `payload.final:true` whose runtime-stamped correlation ID matches the durable task/send `anchorId`.
- `waitFor:"collect"`: wait for a report from `to` whose `correlationId === anchorId` (the collect request ID).
- Default `timeoutSeconds` is 300; accepted range is 1–900; honor the tool `AbortSignal` immediately.
- Poll the disk-backed main mailbox with bounded backoff; do not busy-wait and do not consume unrelated agents' mail.
- Return early with `status:"attention"` if the awaited agent sends a question, escalation, or error after the anchor. Include its envelope ID/text so the main agent can respond and call `subagent_await` again with the same anchor.
- Progress reports may be accumulated and returned with a completed/attention result, but do not terminate the wait.
- On completion, atomically claim the matching final/collect report plus its accumulated progress, park them as `await-tool-result`, validate collect data through the existing schema index, and return a bounded tool result.
- On timeout, return `status:"timeout"` and leave every envelope pending.
- On cancellation or crash before durable host append, leave/requeue the envelope for later digest/await delivery.
- If the agent retires before reporting and no matching report is pending, return `status:"retired"`.

Result shape:

```json
{
  "status": "completed|attention|timeout|retired",
  "to": "type/id",
  "anchorId": "msg_...",
  "report": { "id": "msg_...", "text": "...", "data": {}, "final": true },
  "progress": [],
  "attention": { "type": "question|escalation|error", "id": "msg_...", "text": "..." }
}
```

Only fields relevant to the status are present.

### 3.7 Bound delegated output

Prevent another oversized/truncated final tool call:

- Set a documented maximum for report text and serialized structured data, aligned with Pi's tool-output limits.
- Return a clear tool error so the subagent can retry with a concise report rather than silently truncating arguments.
- The delegated-review procedure requires a decision-first report with bounded sections and forbids raw file dumps.
- `subagent_await` truncates only its LLM-facing rendering; the durable envelope remains available in the session-owned audit mailbox until normal retention GC.

### 3.8 Make retirement cancellation-aware

Change retirement cleanup by sender class:

- Pending messages/collect requests from the owning `main` are moved to an audited cancellation area/`.done` without generating delivery-failure mail back to that same main.
- Pending messages from `user` are canceled with one local notice/audit entry, not one main-mail error per envelope.
- Pending peer questions/messages still bounce so peers are not stranded.
- Cancel pending escalation records first. If their escalation envelope is still pending in main mail, claim/finalize it as canceled; if already delivered, future rendering labels it resolved instead of requesting obsolete human action.
- Return cancellation counts in internal details and TUI notification, while keeping the public destructive result concise.

Do not add a general “quiet discard” option for peer mail.

### 3.9 Add explicit legacy adoption

Add a human-only `/agents adopt-legacy` command; do not expose it to an LLM tool.

Two-phase migration:

1. Detect pre-digest and current cwd-wide roots without opening/draining them.
2. Require a persisted current main session and an empty destination owner scope.
3. Confirm interactively and require all other Pi processes in the cwd to be closed; refuse any live foreign run-owner/host lease.
4. Acquire a project migration lock and write an intent ledger.
5. Rename the old root to a timestamped inactive backup.
6. Copy the backup into a staging owner root; verify registry, teams, envelope IDs, session files, and counts.
7. Atomically rename staging to the final owner root and write `scope.json` plus completion ledger.
8. Reconcile the adopted main mailbox only against the selected current session after activation.
9. Keep the inactive backup for explicit rollback/retention; never auto-open it.

Rollback is allowed only before the adopted scope diverges, verified by the migration ledger. After divergence, provide export/manual recovery rather than guessing at a merge.

### 3.10 Make delegated-review reporting a durable procedure

Create a reusable procedure and a short mandatory pointer in shared `AGENTS.md`:

1. Use one narrowly scoped reviewer by default; add more only for independent purviews.
2. Give the initial task a strict report contract and size bound.
3. Use a unique oneshot for one review assignment.
4. Capture `taskEnvelopeId`, call `subagent_await(waitFor:"final")`, and do not say “review complete” before `status:"completed"`.
5. If `attention`, answer/escalate, then await again.
6. If timeout, tell the user the review is still pending; do not substitute operational logs for findings.
7. If canceled, state explicitly that independent review is incomplete.
8. Let oneshots auto-retire after their final report. Never interrupt, send “finalize,” and immediately retire.
9. User response order: verdict → findings → fixes/decision → verification → one-line operational caveat.
10. Delivery/escalation cleanup noise is summarized only after the result and never presented as the review itself.

Update reviewer/scout type guidance to use dedicated read/find/grep tools instead of opaque Bash pipelines and add conservative turn/token ceilings appropriate to their role.

## 4. Implementation phases

Each phase ends green and is committed separately.

### Phase 0 — Contract and fixtures

- Add a new design-log decision superseding D3 and D16 where necessary.
- Update envelope/tool specs with owner scope, final report metadata, anchors, and await semantics.
- Add deterministic main-session IDs to harness utilities before changing production paths.
- Add failing tests for two sessions in one cwd, same-session duplicate open, await-before/after-report, timeout, and quiet retirement.

### Phase 1 — Layout v2 and session binding

- Implement `ProjectLayout`/`SessionLayout`, `scope.json`, session-ID validation, and ephemeral layout.
- Thread the session locator through `createCore`, index lifecycle, latch, GC, reconciliation, runtime, archive, and sandbox.
- Keep legacy state detection read-only; no adoption yet.
- Add fork/new/resume/reload behavior and notices.

### Phase 2 — Host lease and persisted autonomy

- Add claim/heartbeat/release/recovery helpers under `store/`.
- Gate core mutation and main auto-wake on lease ownership.
- Persist autonomy transactions and restore them with the session.
- Add observer-mode TUI/status messaging for a duplicate same-session process.

### Phase 3 — Atomic main mailbox

- Replace read-then-move main drains with claim-first delivery.
- Generalize host-delivery metadata and reconciliation for digest and tool-result markers.
- Prove crash-before-append redelivery and same-session process exclusion.

### Phase 4 — Anchors, final metadata, and `subagent_await`

- Extend envelope/report metadata.
- Surface spawn/send anchor IDs.
- Add runtime/core await operation and main-agent tool.
- Add attention early-return, timeout, cancellation, collect validation, bounded output, and durable tool-result reconciliation.

### Phase 5 — Retirement and escalation cleanup

- Split main/user cancellation from peer bounce behavior.
- Resolve/prune obsolete escalation mail during retirement.
- Add cancellation audit and compact TUI feedback.

### Phase 6 — Legacy adoption

- Implement detection, confirmation, lease/run-owner checks, migration ledger, inactive backup, staging verification, activation, and guarded rollback.
- Add interrupted-migration recovery tests for every rename/copy window.

### Phase 7 — Procedure, docs, and dogfood

- Add shared delegated-review procedure and AGENTS pointer.
- Tighten reviewer/scout report contracts and budgets.
- Update README, manifest, tool descriptions, TUI spec, architecture spec, envelope contract, tool surface, type schema notes, and design log.
- Dogfood one delegated review end to end and verify the user receives the result before any cleanup details.

## 5. File-level deliverables

### Production code

- `configs/pi-agent/packages/pi-agents/extensions/subagents/store/layout.ts` — project/session layout split and v2 paths.
- `.../store/session-scope.ts` (new) — scope manifest, host lease, migration ledger, and ephemeral metadata.
- `.../store/archive.ts` — owner-scope enumeration and GC.
- `.../store/settings.ts` — any ownership/timeout limits that are intentionally configurable.
- `.../rails/autonomy.ts` — serializable budget snapshot/restore hooks.
- `.../mail/envelope.ts` — final-report metadata and validation.
- `.../mail/mailbox.ts` — atomic claim-first host delivery and mode-aware reconciliation.
- `.../mail/deliver.ts` — pass final metadata and owner-local routing.
- `.../runtime/types.ts` — task anchor, await, and attention result contracts.
- `.../runtime/in-process.ts` — final metadata, anchor capture, await integration, sandbox container denial, retirement cleanup.
- `.../core.ts` — session-aware facade, await operation, lease checks, owner-local reconciliation/GC.
- `.../tools/main-agent.ts` — additive envelope IDs and `subagent_await`.
- `.../tools/sub-agent.ts` — final metadata and report bounds.
- `.../index.ts` — lifecycle binding, fork notice, observer mode, adoption command, ephemeral cleanup.
- `.../tui/widget.ts`, `picker.ts`, `viewer.ts`, `escalation-modal.ts` — current-session/locked/canceled states.

### Tests

Update every harness that constructs `Layout` or `Core`, with primary additions in:

- `phase1-data-layer.mjs` — layout, validation, scope manifest, migration state.
- `phase2-runtime.mjs` — same address isolated by owner, resume continuity.
- `phase3-mail.mjs` — owner-local routing, anchor IDs, final metadata.
- `phase4-teams-rails.mjs` — owner-local teams and persisted autonomy.
- `phase5-sandbox.mjs` — sibling scope and backup hard denial.
- `phase6-tui.mjs` — observer, fork notice, canceled escalation display.
- `phase7-full-story.mjs` — full new/resume/fork + await procedure.
- `phase-lifecycle-fixes.mjs` — quiet main cancellation and peer bounce.
- `phase-runtime-fixes.mjs` — host lease, atomic claims, crash/redelivery, await durability.
- Add `phase-session-scope-await.mjs` if keeping these cases separate makes the existing phases unreadable.
- `loadcheck.mjs` — eight tools and updated command surface.

### Documentation and reusable process

- `configs/subagent-docs/00-design-log.md` — new confirmed decision superseding D3.
- `01-power-matrix.md`, `02-envelope-contract.md`, `03-tool-surface.md`, `05-tui-spec.md`, `06-architecture.md` — updated contracts.
- `configs/pi-agent/packages/pi-agents/README.md` and `configs/pi-agent/MANIFEST.md` — user-facing behavior and migration.
- `procedures/reviews/delegated-review-results/delegated-review-results.md` (new) — reusable reporting protocol.
- `AGENTS.md` — concise mandatory rule linking to the procedure.
- Global reviewer/scout type definitions — bounded output, least-privilege tool guidance, and budgets.

## 6. Hardest constraint proof: the review result reaches the user before completion is claimed

1. Spawn/send returns an anchor envelope ID in the main tool result.
2. The main agent immediately calls `subagent_await` in the same run; `mainBusy` prevents ordinary auto-wake from racing it.
3. The awaited worker runs independently inside its session-owned scope.
4. A question/escalation/error causes await to return `attention`, so the main LLM can act; it never deadlocks waiting for a worker that needs main input.
5. A final/collect report is atomically claimed before another consumer can digest it.
6. The report is returned as the `subagent_await` tool result, making it available to the main LLM before that LLM writes its user-facing answer.
7. The envelope remains parked until the host session JSONL durably contains the await tool result.
8. A crash before append requeues it; a completed append finalizes it exactly once.
9. Shared instructions forbid declaring completion for timeout/cancellation/attention states.
10. The response template puts the actual verdict and findings first.

Thus the prior failure mode—main answer first, report mail next turn, then cleanup noise—is closed end to end.

## 7. Risks and dispositions

| Risk | Disposition |
|---|---|
| Fork transcript references non-inherited agents | Mitigate with explicit injected notice; cloning remains out of scope. |
| Same-session lease stale after crash/PID reuse | Runtime ID + heartbeat + locked stale-owner recovery; retain per-agent run-owner defense. |
| Await blocks while worker needs main input | Return early on question/escalation/error; covered by end-to-end test. |
| Await result marked done before host append | Reuse generalized `.delivering` reconciliation with await marker. |
| Oversized reports fail or overwhelm context | Enforce report/data limits, concise procedure, bounded rendering, durable audit copy. |
| Legacy adoption duplicates pending mail | Move/copy only into inactive staging; keep backup inactive; never activate two copies. |
| Migration interrupted mid-copy/rename | Intent/completion ledger and idempotent recovery for each window. |
| Ephemeral persistent agent becomes unreachable | Reject persistent lifetime; temporary oneshot-only scope. |
| Project-wide worker-pool users lose D3 behavior | Document as intentional breaking change; explicit legacy adoption; no silent fallback. |
| Cross-session archive overview is lost | Current-session archive only for v1; project overview is a later feature. |
| Persisted autonomy file contention | Use the existing cross-process file-lock/atomic-write pattern. |
| Tool count grows from seven to eight | Accept: await is a distinct blocking/join intent and must not change collect's non-blocking default. |
| Existing uncommitted TUI work overlaps touched files | Before execution, isolate this program on a clean branch/worktree and reapply only verified current changes. |

## 8. Verification script

1. Run strict typecheck and the full existing e2e runner.
2. Create two deterministic session layouts for one cwd; assert every mutable path differs and shared type/settings paths match.
3. Spawn the same `<type>/<id>` in both scopes; assert separate registry, JSONL, teams, mail, and status.
4. Restart/resume one scope; assert memory/mail/archive/autonomy restore. Start `/new`; assert empty. Simulate fork; assert empty plus isolation notice.
5. Open the same session scope through two runtime instances; assert one host lease wins, the loser cannot mutate or consume mail, and takeover works after owner shutdown/crash.
6. Send reports to both session owners concurrently; assert no cross-delivery or cross-reconciliation.
7. Crash after atomic claim but before digest append; assert one labeled redelivery. Append successfully; assert exactly-once finalization.
8. Spawn a oneshot review task, capture `taskEnvelopeId`, await final, and assert the final report appears in the await tool result before the main response path proceeds.
9. Repeat with report arriving before await starts; assert it is found. Repeat with an older stale report; assert the anchor excludes it.
10. While awaiting, make the worker ask a question; assert `attention`, answer it, await again, and receive final.
11. Repeat for escalation and error attention; assert no deadlock and obsolete escalation cleanup after retirement.
12. Test timeout and AbortSignal cancellation; assert no envelopes are consumed and later digest/await delivery still works.
13. Fulfill a collect request; assert correlated await validation verdict matches the existing restricted schema semantics.
14. Interrupt and retire a worker with pending main, user, and peer mail; assert main/user messages are audited without bounce spam, peer question bounces once, and no stale approval prompt remains.
15. Exercise report text/data limits; assert an oversized report gets a retryable error and a concise retry succeeds.
16. Run legacy adoption success, destination-nonempty refusal, live-owner refusal, copy failure, crash recovery, and guarded rollback fixtures. Verify source backup and destination counts/hashes.
17. Run ephemeral mode; assert persistent spawn is rejected, oneshot works, and temporary scope is removed at shutdown.
18. Run TUI width/key tests for locked scope, fork notice, canceled escalation, current-session roster, and await status rendering.
19. Run the real Pi extension loader and assert eight tools, `/agents` adoption command behavior, and shortcuts register cleanly.
20. Dogfood a delegated code review. Confirm the first user-facing completion message contains verdict/findings; no later mail digest is needed to discover the result.

## 9. Rollout and rollback

- Implement in the numbered phases; do not combine migration, await, and retirement changes in one commit.
- Keep the legacy cwd-wide root inactive and untouched until explicit adoption.
- Before adoption, rollback is simply reverting the extension because the old state was never moved.
- During adoption, the ledger and inactive backup restore the exact pre-adoption root if activation has not diverged.
- After the scoped system has new turns/mail, do not auto-merge backward. Export the scope and require an explicit human recovery decision.
- Do not switch production activation until the complete verification script and one dogfood review pass.

## 10. Effort estimate

| Workstream | Estimate |
|---|---:|
| Session layout, lifecycle, sandbox, GC | 3–4 days |
| Host lease, persisted autonomy, atomic mailbox | 2–3 days |
| Anchors, final metadata, `subagent_await` durability | 2–3 days |
| Retirement/escalation cleanup | 1–2 days |
| Legacy adoption and rollback | 1–2 days |
| Procedure, docs, type guidance, dogfood | 1 day |
| **Combined production-safe program** | **10–15 engineer-days** |

The work overlaps (especially atomic mail with await), so this is not the sum of worst cases. Fork cloning, project-wide cross-session browsing, and backward merging after scoped divergence remain explicitly outside this estimate.
