# Pi Subagents Feature Test Results

Companion to `configs/pi-agent/docs/agents/plans/testing/pi-subagents-feature-validation/pi-subagents-feature-validation.md`.

## Overall status

**The four confirmed defects are fixed and verified.** Both strict suites are green, and the three runtime defects passed focused live retests after `/reload`. The previously listed TUI-only/manual gaps remain outside this fix scope.

## Post-fix verification

1. **Automated suite:** `pi-subagents/test/e2e/run.sh` passed strict typecheck and all 9 harnesses.
2. **Spawn with initial task:** a new ad-hoc oneshot ran immediately, returned `SPAWN-TASK-FIXED`, and completed normally.
3. **Model override:** a valid `openai-codex/gpt-5.6-sol` agent with `thinking: low` returned `MODEL-OVERRIDE-FIXED`.
4. **Same-agent await:** task B was held while task A ran; one await returned distinct correctly correlated `A-FIXED` and `B-FIXED` reports.
5. **Coexistence:** `pi-teams` passed its strict 11-harness suite and a live oneshot returned `TEAMS-LIVE-FIXED` after reload.
6. **Cleanup:** final subagent roster and open-task list were empty.

Implementation details: `configs/pi-agent/docs/agents/notes/testing/pi-subagents-defect-fixes/pi-subagents-defect-fixes.md`.

## Pre-fix focused retest (historical)

Before implementation, a focused retest reran all four failed contracts and reproduced all four unchanged. The evidence below documents the original failure state.

## Original confirmed defects (fixed)

### D1 — Spawn with an initial task does not start a newly created agent

- **Reproduction:** `subagent_spawn` with a valid ad-hoc definition plus `task` returned an address and anchor, but the agent remained `dormant`, had `unread: 1`, `turns: 0`, and produced no session file or report. A subsequent `subagent_send` also left the mail pending for that affected instance.
- **Control:** Spawn the same kind of agent without `task`, then use `subagent_send`; it wakes, runs, and reports normally.
- **Affected contract:** Normal async spawn+task flow, default ad-hoc oneshot flow, and inherited host-model selection.
- **Likely cause:** Spawn+task stores an inherited model reference. `runtime/in-process.ts` calls `resolveCliModel({ cliModel, modelRegistry })`, but the installed SDK now requires `modelRuntime`. Handle construction fails and leaves mail pending.

### D2 — Explicit model override cannot start a turn

- **Reproduction:** A persistent ad-hoc agent with valid `model: openai-codex/gpt-5.6-sol` and `thinking: low` spawned dormant. Sending it work returned `woken`, but it returned to dormant with `unread: 1`, `turns: 0`, and no session file/report.
- **Affected contract:** Per-agent model overrides; model selection on typed definitions is affected by the same resolver path.
- **Likely cause:** Same installed-SDK `ModelRuntime` migration as D1.

### D3 — Await can report a held same-agent task complete before that task runs

- **Reproduction:** Send task A to a dormant agent; while A is running, send task B. B correctly returns `disposition: held`. Await both anchors. When A’s final report arrives, `subagent_await` returns both A and B as completed using A’s report, even though B has not yet been delivered at its next turn boundary.
- **Proof:** A later status tail showed B running in a separate subsequent turn, followed by a distinct final report correlated to B. Awaiting B again returned that real B report.
- **Affected contract:** Anchor correctness and the statement that one final report closes only work drained into that turn.
- **Cause in behavior:** Await closes every open anchor for an address on any final report; it cannot distinguish mail drained into the completed turn from mail held for the next turn.

### D4 — The pi-subagents verification suite is incompatible with the installed SDK

- **Strict typecheck failures:**
  1. `AuthStorage` is no longer exported from the package root.
  2. The same stale `AuthStorage` import appears in `runtime/in-process.ts`.
  3. `resolveCliModel` no longer accepts `modelRegistry`; it requires `modelRuntime`.
- **Runtime harness failure with typecheck skipped:** `piSdk.AuthStorage` is `undefined`, so phase 3 aborts before runtime checks.
- **Result:** The advertised one-command verification suite is red.

## Original automated evidence (historical)

- `pi-subagents/test/e2e/run.sh`: **FAIL** at strict typecheck (D4).
- `SKIP_TYPECHECK=1 pi-subagents/test/e2e/run.sh`:
  - Phase 1 data/settings/mail/open-task checks: **12 PASS**.
  - Phase 2 typedef/trust/synthesis checks: **8 PASS**.
  - Phase 3 and later: **BLOCKED** by removed `AuthStorage` API.
- Standalone extension loadcheck: **PASS** — seven tools and `/subagents` register.
- Standalone shortcut loadcheck: **PASS** — `alt+a` registers.
- Isolated safety/allowlist contracts: **PASS**.
- Isolated host-lease claim/block/release: **PASS**.
- Isolated persistent registry/ad-hoc-constitution reload: **PASS**.
- Pure TUI rendering checks (tree, status text, picker rows): **PASS**.
- Full `pi-teams` automated suite: **PASS** — strict typecheck plus 11 harnesses.
- Live pi-teams coexistence task: **FAIL/BLOCKED** before start with `Cannot read properties of undefined (reading 'getModels')`; this is a live teams/runtime compatibility issue, so successful concurrent work by both extensions was not proven.

## Checklist verdicts

| # | Feature | Verdict | Evidence |
|---:|---|---|---|
| 1 | Extension availability/base status | PASS | Empty roster and open-task list returned cleanly. |
| 2 | Persistent ad-hoc spawn without work | PASS | `created:true`, dormant, zero turns/open tasks. |
| 3 | Detailed status read-only | PASS | Stable repeated detail/tail inspection. |
| 4 | Persistent get-or-create | PASS | `created:false`; later transcript memory retained. |
| 5 | Send to dormant | PASS | `woken`, anchor returned, final report correlated. |
| 6 | Single-target await | PASS | Completed outcome, report consumed, task closed. |
| 7 | Send while busy/turn boundary | PASS | Second send returned `held`, ran in the next turn, and now resolves only from its own terminal report. |
| 8 | Mid-turn steering | PASS | Running steer returned true and marker appeared; dormant steer returned false. |
| 9 | Running cancellation | PASS | Cancel true; dormant afterward; unread triggering mail retained. |
| 10 | Resume after cancellation | PASS | New send redelivered pending mail; final report completed both drained anchors. |
| 11 | Queued cancellation | PASS | Fifth agent queued under cap 4; cancel left it dormant with unread mail and zero turns. |
| 12 | Await `any` | PASS | Fast result returned; slow target remained pending and joinable. |
| 13 | Await omitted targets/all | PASS | All current open anchors joined after queued-cancel resume. |
| 14 | Await timeout/partials | PASS | One-second timeout returned unresolved target; later work remained controllable. |
| 15 | Fatal-error await outcome | PASS (automated) | Current phase 4 harness resolves the target as error and closes only its terminal task anchors. |
| 16 | Typed definition discovery | PASS | Temporary trusted project type spawned as `validation-worker/main`. |
| 17 | Tolerant parsing/known-field validation | PASS | Foreign `peers` key loaded; invalid `thinking: warp` failed clearly. |
| 18 | Project trust/shadowing | PASS (automated) | Phase 2 verified trusted shadowing and untrusted exclusion. |
| 19 | Model/thinking selection | PASS | Post-fix live model override and inherited spawn-with-task selection both completed. |
| 20 | Coding-tool allowlist | PASS | `tools:[]` worker reported only `report`; read unavailable. |
| 21 | No nesting/no peer control | PASS | Worker exposed no subagent/team/peer control tools. |
| 22 | Safety confirmation/waiting state | BLOCKED live | Current safety mode is `off`; isolated claim/fail-closed protocol passed, but live approval/denial UI and waiting state were not exercised. |
| 23 | Protected hard deny/fail-closed | PASS | Live write to `.pi/subagents` hard-denied and fixture remained unchanged; isolated unclaimed bridge denied. |
| 24 | Ad-hoc oneshot lifecycle | PASS | Normal spawn-with-task oneshot completed live after the ModelRuntime migration; automated archival coverage also passed. |
| 25 | Persistent retirement | PASS | Archive created, later send bounced, repeat retire returned null archive. |
| 26 | Idle auto-wake | PASS | The unconsumed final report triggered an autonomous follow-up after the main turn settled. A competing teams wake ran first; the subagents digest remained queued and delivered on the next boundary, with the target anchor committed exactly once. |
| 27 | Mid-turn wake deferral | PASS | Finished report remained pending/open throughout the active main turn. |
| 28 | Concurrency cap/FIFO | PASS/PARTIAL | Live status showed exactly 4 running + 1 queued at default cap 4; FIFO order beyond the first queued worker was not separately observed. |
| 29 | Status/activity tree/counts | PASS/PARTIAL | Tool states and pure render contracts passed; visual placement was not machine-observable. |
| 30 | `/subagents` picker interactions | MANUAL | Rendering helpers passed; navigation/cancel/retire/stop key interaction needs user observation. |
| 31 | Viewer interactions | MANUAL | Registration/source inspected; overlay, Enter, Alt+Enter, Alt+J, and Esc require interactive observation. |
| 32 | Global stop brake | MANUAL/BLOCKED | Shortcut/command registration passed; invoking human-only brake was not available through agent tools. |
| 33 | Reload/resume persistence | PASS | Phase 7 verifies typed and persistent ad-hoc history, constitution, roster, and vitals across a fresh runtime. |
| 34 | Single-host lease | PASS | Isolated exclusive claim, rejection, release, and reclaim passed. |
| 35 | Non-persisted-session unavailable state | MANUAL/BLOCKED | Requires isolated no-session Pi lifecycle; not exercised in the active persisted session. |
| 36 | Coexistence with pi-teams | PASS | Both strict suites pass and a post-reload live teams oneshot returned `TEAMS-LIVE-FIXED`. |
| 37 | Shutdown/retention cleanup | PASS/PARTIAL | All test agents were retired, live roster/open tasks returned empty, and temporary fixtures were removed. Isolated lease release passed; quitting this active Pi session was not performed. |
| 38 | Final automated regression | PASS | pi-subagents strict typecheck + 9 harnesses and pi-teams strict typecheck + 11 harnesses are green. |

## Live pass details

- Status returned running, queued, dormant, unread, vitals, transcript tails, and open anchors accurately.
- Default concurrency cap was observed live as four running workers and one queued worker.
- A five-agent fan-out completed for four workers; the queued fifth was cancelled before streaming and later resumed from pending mail.
- `subagent_await` single, any, all/omitted-target, empty, timeout, drained-batch, and held-next-turn behavior now match their contracts.
- A running steer changed the final report; cancellation retained pending mail; subsequent send resumed it.
- Oneshots work both with an initial spawn task and with a later send; automated coverage verifies transcript archival.
- Protected extension/type-definition paths were hard-denied before mutation.
- Input validation rejected missing/both type/prompt, named oneshots, unnamed persistent ad-hoc agents, unknown tools, malformed known frontmatter, and non-agent recipients.

## Cleanup status

- Retired: all ad-hoc lifecycle, control, concurrency, safety, model, and coexistence fixtures.
- Removed: temporary invalid type definition and `/tmp` safety file.
- Retired the final `validation-worker/main` fixture after idle auto-wake delivery.
- Removed both temporary project type definitions and the `/tmp` safety file.
- Final live status: zero agents and zero open tasks.
- Existing unrelated worktree changes were not cleaned, reset, or overwritten.
