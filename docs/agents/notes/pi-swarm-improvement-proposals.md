# PI-SWARM IMPROVEMENT IDEAS — OBSERVATIONS FROM THE CURRENT RUN

Status: proposals, not implementation findings. These notes are based on observed tool responses, coordination messages, and owner interactions. The extension source was not inspected; some suggestions may improve discoverability of capabilities that already exist.

## SUMMARY

The biggest opportunities are reducing coordination overhead, exposing remaining budgets, making policy changes converge quickly, and providing an explicit wrap-up workflow. Preserve the existing approval, claim-admission, and unresolved-execution safety protections; do not replace them with optimistic releases or agent assurances.

## P0 — HIGHEST PRIORITY

### 1. Expose exact remaining budgets in status

Observed: worker and task counts were available, but elapsed/remaining time and per-task attempt usage were not. Usage was reported as not aggregated and cost as unknown. This made the owner's limits question only partly answerable.

Proposal: show elapsed time, deadline, remaining duration, workers/active/tasks used versus allowed, per-task attempts used, and queued work. Distinguish active model turns from assigned tasks. Show token/cost totals only where measured; label unavailable values explicitly.

Acceptance: one concise status response answers whether any limit is near, exhausted, or blocking admission. Include configurable near-limit warnings without silently extending allowances.

### 2. Make workspace handoffs runtime-managed rather than conversational

Observed: contributors repeatedly waited for FINISHED messages, inspected each other's histories, and requested direct acknowledgments after board acknowledgments. Final diff reviews and constant replacements spent substantial effort coordinating short Git windows.

Proposal: provide a runtime-managed fair queue for protected read windows and mutations, with an observable completion receipt and automatic waiter notification after actual settlement. Permit compatible source reads where safe. Name the holder, requested scope, blockers, and queue position.

Acceptance: a worker does not need to poll transcripts or ask another worker to repeat an acknowledgment. Unknown execution effects continue blocking release; no timeout-based or forced unlock.

### 3. Make policy revisions structured and acknowledged

Observed: owner corrections changed the design substantially. Earlier callback APIs, attribution helpers, and tests had to be removed while workers were receiving delayed messages.

Proposal: maintain a versioned run contract containing current constraints and superseded decisions. Deliver an explicit contract delta to each worker and record acknowledgment. Block new conflicting mutations until the worker has accepted the current revision; do not abort an already executing command without safe settlement.

Acceptance: status shows each worker's acknowledged contract revision. A stale message cannot restore an obsolete design or grant owner authorization.

### 4. Add an explicit wrap-up mode

Observed: the owner had to ask the main agent to tell the team to start wrapping up. That translated into a lengthy board message, while dependencies and reviews remained scattered.

Proposal: a wrap-up transition freezes new scope and recruitment, allows bounded completion of already approved edits, prioritizes required reviews, and requests one structured final handoff per worker. Show the exact remaining critical path and unresolved blockers.

Acceptance: wrap-up ends with either a reviewed deliverable or an honest incomplete handoff. It never invents completion, skips review, silently increases budgets, or commits/deploys automatically.

## P1 — WORKFLOW AND REVIEW

### 5. Decouple review assignments from implementation task kinds

Observed: formal review admission returned 'Task not ready to review'; a separate investigation task was used to obtain an independent read-only reviewer. Review capacity was awkward under the four-worker limit.

Proposal: allow a bounded preliminary review of a named snapshot, clearly distinct from final candidate acceptance. Make reviewer reassignment explicit and preserve the no-self-approval rule. Show the dependency that prevents final review and the action needed to satisfy it.

Acceptance: preliminary review cannot mark a task complete; final acceptance still requires a submitted candidate and an eligible independent reviewer.

### 6. Reuse valid receipts and invalidate only affected review scope

Observed: several workers requested their own Git/status receipts even after another worker had collected fresh ones. Constant replacements required a new review but did not require reopening the entire business-flow design.

Proposal: publish reusable, scope-bound receipts with snapshot identity, paths, operation settlement, and review type. Indicate which later edits invalidate which findings. Allow a delta review of enum substitutions when the baseline flow review remains applicable.

Acceptance: reused receipts meet existing freshness requirements. Later mutations mark affected findings stale automatically; source review is never represented as runtime verification.

### 7. Improve edit conflict reporting

Observed: edit tools reported 'workspace changed during snapshot' even though requested replacements appeared in subsequent reads. Workers had to determine whether retrying would duplicate or overwrite work.

Proposal: distinguish not-applied, fully-applied, partially-applied, and unknown outcomes using authoritative edit results and before/after fingerprints where possible. Give exact affected paths and safe recovery guidance.

Acceptance: a worker can tell when to reread rather than replay. Unknown effects remain unknown until reconciled; an error never triggers an automatic blind retry.

### 8. Use structured final handoffs

Observed: long free-text reports repeatedly mixed completion, claim release, provenance, coverage gaps, deployment prerequisites, and candidate status.

Proposal: require final fields for changed paths, settled operations, claim state, completed acceptance criteria, remaining work, review evidence, verification actually performed, explicit exclusions, and operator prerequisites. Keep candidate submission separate from accepted completion.

Acceptance: the main agent can assemble a final report without reconstructing many overlapping messages, and cannot mistake a worker's assurance for review approval.

### 9. Surface completed work awaiting acceptance separately from blocked work

Observed: status showed zero completed tasks and several blocked tasks although substantial implementation and preliminary review had finished. 'Blocked' covered very different conditions: yielding a slot, awaiting migration, awaiting review, and unresolved prerequisites.

Proposal: distinguish implementing, awaiting handoff, submitted, awaiting independent review, accepted, and blocked-on-owner/runtime/dependency. Show why a worker is active with no assigned task and whether it is processing mail or waiting.

Acceptance: progress remains truthful while clearly exposing work already delivered and the actual remaining bottleneck.

## P2 — CONTEXT AND USABILITY

### 10. Return compact status by default

Observed: send/status responses repeatedly included a large rolling message history with stale blockers and superseded instructions. This increased context consumption and obscured recent changes.

Proposal: default to a short structured delta: current state, budgets, task changes, claim queue, new blockers, and message delivery acknowledgment. Make full histories an explicit paginated request.

Acceptance: a simple send does not replay unrelated historical messages. Important unresolved safety states remain visible.

### 11. Deduplicate and prioritize mail without dropping evidence

Observed: delayed batches prompted repeated provenance confirmations and migration acknowledgments after the relevant cleanup had already finished.

Proposal: attach topic revision, supersedes references, priority, and acknowledgment state. Coalesce equivalent notifications and display obsolete messages as historical rather than actionable. Deliver current owner-contract changes ahead of routine chatter at the next safe boundary.

Acceptance: original messages remain inspectable; deduplication cannot erase unresolved execution or reinterpret peer text as owner consent.

### 12. Separate local workflow completion from rollout readiness

Observed: code-review findings, missing runtime verification, coverage exclusions, IAM review, and retention decisions all remained relevant but were not equivalent blockers.

Proposal: a final dashboard separates implementation acceptance, verification status, known coverage gaps, operator prerequisites, and authorization needed for next actions.

Acceptance: a locally reviewable change is not advertised as deployed, compliant, immutable, fully audited, or runtime-tested. No tests, cloud actions, or publication occur without the required authorization.

## SUGGESTED DELIVERY ORDER

1. Compact budget/status reporting and clearer task states.
2. Settled handoff notifications and reusable scoped receipts.
3. Versioned worker contract acknowledgments.
4. Wrap-up mode and structured final reports.
5. Snapshot-bound preliminary/delta review and better edit outcome reporting.

## EVALUATION IDEAS — NOT EXECUTED

Use a controlled multi-worker scenario with a mid-run owner correction, disjoint file edits, a protected Git window, and a near-deadline wrap-up. Compare coordination messages, waiting time, redundant commands, stale-policy edits, context volume, and time to reviewed handoff. Also exercise unknown command effects and conflicting edits to ensure reduced overhead never weakens settlement or consent protections.

## Follow-up implementation and observations — 2026-10-08

This section records a later source inspection and live implementation run. The original proposals above remain intact; their original observations are not retroactively treated as verified source findings.

### Proposals 1 and 10 implemented

A fresh Pi Swarm in the existing owner chat built and independently reviewed the changes. The planner used `gpt-6-luna` with low thinking; the implementer and reviewer used `gpt-6.1-sol` with low thinking. The live Agents page confirmed those selections. The approved limits were three worker identities, two active turns, eight task creations, three failed attempts per task and a 30-minute runtime allowance. No allowance was extended.

- Main-agent status now reports sampled elapsed/remaining runtime allowance, retained worker identities, task creations, native turns, assigned tasks, known queued workers, runtime activity and SDK idle state. Missing counters are explicit. It reports settled task failures rather than charging successful assignments as attempts.
- `warningThreshold` is a bounded presentation option, validated before status restoration/control. Exhausted fields name the admission they prevent. Exhausted-task counts and identifiers remain visible beyond the first page of ordinary task rows.
- Default main-agent status no longer includes rolling message bodies. Explicit message/native-history pagination remains available; `swarm_history` now also supports task pages and a specific `taskId`.
- Main-agent sends return their own durable operation/revision receipt plus compact budget/safety state. Persistence, queue admission and worker acknowledgment are distinct. If queue admission declines after persistence, the receipt says `not-enqueued`; admitted wakeups still do not guarantee later execution.
- Ownership, recovery, unknown-effect and runtime-error signals remain visible. This work did not redesign claims, admission, recovery, approval or budget enforcement. Worker-side status and startup-context compaction remain separate opportunities; proposal 10 is not a claim that every context source is now compact or delta-based. The final live check also showed the existing human-facing status notification still expanding task JSON in the terminal (`ui.mjs` / `statusText`), even though the model-facing tool result is compact. Condensing that notification remains a presentation follow-up.

Runtime allowance is event-sampled active time, including relevant draining states. Paused time is not charged. `deadline: null` avoids inventing an unconditional wall-clock deadline. Token usage remains unaggregated and cost unknown. Field semantics and examples are in the [package README](../../../packages/pi-swarm/README.md#compact-observations-and-allowances).

### New observations while operating the swarm

1. **Review admission and task discoverability (proposals 5 and 9).** The reviewer initially attempted a workspace read without an assignment and received `Claim a task before workspace operations`. It then created a separate review task dependent on implementation and tried to yield without owning it, receiving `Task belongs to another worker`. Steering it to claim the submitted implementation with `kind: review` avoided a circular dependency. The original assignment and no-self-approval protections remained intact.
2. **Notification timing (proposal 2).** On both submissions, the implementer sent a candidate-ready message immediately before `swarm_report`. The reviewer woke while submission was not yet settled, replied that it was waiting, and needed a later notification once the candidate was actually submitted. This is direct evidence for a settlement-triggered handoff notification; it is not permission to unlock based on messages.
3. **Redundant and stale coordination (proposals 10 and 11).** A planner repeated a review instruction already delivered by the coordinator. Later, the coordinator asked for rejection after the reviewer had already rejected and settled it. Those messages caused additional worker turns with no new work. Polling and pre-settlement handoffs contributed to delays; no controlled baseline comparison of waiting time or token savings was performed.
4. **Independent review caught a receipt defect.** The first candidate reported `dispatch: enqueued` even when the enqueue helper could decline after persistence during pause/stop. Review rejected it. The implementer waited for review settlement, reclaimed the task, corrected the result and added a bounded race regression. The second review approved it. This was a source-level finding with deterministic regression coverage, not a pause/stop fault injected into the live implementation run.
5. **SDK test discovery.** An isolated reviewer reproduction using plain Node imports failed to resolve the managed SDK package. The repository's SDK registration hook is required for such tests; no dependency installation was needed. Use `node --experimental-import-meta-resolve --import ./packages/pi-swarm/test/sdk-register.mjs --test <test-file>` from the repository root.
6. **Progress labels remain a separate concern (proposal 9).** The implementation task became `done` after accepted independent review, while the yielded research task and unnecessary review-wrapper task remained `ready`. The team was explicitly stopped after the reviewed handoff; the run was not falsely marked completed merely to clear those auxiliary rows.

### Source finding for proposal 3

The existing reducer already has `guidanceRevision`, `worker.ack` and a guard against stale worker guidance. The session driver records acknowledgment at a turn boundary. A future proposal 3 audit should build on those mechanisms and distinguish runtime delivery from a worker understanding a structured contract. This inspection does not establish that superseded decisions, explicit contract deltas and semantic acknowledgment are already implemented.

### Verification and limits

- First full package pass after implementation: **737/737** tests, with **10/10** configuration fixture tests. After the receipt correction, **77/77** status/extension tests and **18/18** SDK driver tests passed. The earlier full-suite result is pre-correction evidence, not a claim that it was rerun afterward. The independent reviewer checked the corrected source and regression without duplicating the broad suite.
- The first test pass exposed assumptions about absent receipt metadata in existing fixtures; those were corrected. A shell receipt also reported failure despite passing tests because another command in the batch returned nonzero. Keep test exit status distinct from unrelated lookup results.
- After normal settlement, the coordinator stopped the team with no active turns, operations, assignments or claims. A cold Pi restart resumed the same owner chat to load changed session modules. Live status and task-detail requests confirmed stopped state, zero known queued workers, idle SDK, **846,883 ms** remaining sampled allowance, and **one failed attempt of three** for the accepted implementation task. No workers were dispatched for this final inspection.
- On the same stopped journal snapshot containing 22 messages, serialized main status was **16,166 bytes** using the prior implementation and **3,479 bytes** using the new implementation: **78.5% smaller**, including the new budget fields. This is a JSON response-size comparison, not a token-cost, billing or end-to-end latency measurement.
- Inventory validation initially reported the existing untracked observations document and two new package files. Final clone-completeness validation passed using a disposable Git index containing the intended changes; the real staging area was verified unchanged. All 19 required shared checks and final diff checks passed. Do not stage unrelated work merely to satisfy the validator.
- No live conflicting-edit or unknown-command-effect fault injection was performed. The broader evaluation scenario above remains unexecuted. No commits, pushes, deployment or dependency installation were performed for this implementation task.

### Reusable monitoring procedure

Use the [desktop-session guide](../../../.agents/docs/guides/linux-desktop-sessions.md) for window selection, wake, native keys and Steer input. For low-overhead local observation, run:

```bash
node docs/agents/scripts/swarm-run-observation.mjs /path/to/events.jsonl
```

The [journal observation helper](../scripts/swarm-run-observation.mjs) uses the existing integrity-checked reader and pure reducer. It emits compact recorded counters without message bodies, host paths or model calls. The helper was checked against the settled run and an unreadable input; the latter failed without reporting an idle state. An inspection racing a write can fail; failure is not proof of settlement. Recorded zero counts do not establish live SDK/process quiescence and cannot authorize recovery or release. Use normal runtime status and settlement paths for transitions. Keep machine-specific journal paths and raw runtime output local.

Wait until workers and operations settle before editing this observations document: external documentation edits during a protected command or review can invalidate the workspace fingerprint. Preserve the distinction between source findings, observed behavior, executed tests and proposed evaluations when adding future entries.

## Token usage audit — 2026-10-08

A metadata-only audit followed an owner report that the account meter rose from 17% to 79%. The Pi footer reads account rate-limit `usedPercent`, not a project-specific token counter. Screenshots around the compact-status implementation showed approximately 73% before its launch and 79% afterward; the entire 62-point increase cannot be assigned to that last change. Concurrent account activity and the subscription's usage accounting prevent an exact percentage attribution from local token logs.

The latest main Pi chat recorded 240 model responses, 9,304,088 uncached input tokens and 14,325,248 cached input tokens across its work. Its per-response input context grew from 13,062 to 112,785 tokens and reached 183,546 at its peak. A small diff therefore did not imply a small amount of model processing.

For the last implementation and final inspection, native session metadata recorded:

| Role | Model responses | Uncached input | Cached input | Output |
|---|---:|---:|---:|---:|
| Pi coordinator | 44 | 701,002 | 2,927,488 | 4,605 |
| Planner | 27 | 36,999 | 193,024 | 1,134 |
| Implementer | 77 | 96,049 | 4,070,400 | 11,652 |
| Reviewer | 28 | 54,596 | 599,552 | 2,601 |

The coordinator accounted for about 79% of Pi's uncached input in this interval. Codex monitoring during approximately the same interval additionally recorded 253,349 uncached input tokens, 11,544,960 cached input tokens and 25,120 output tokens. Its 10,601 reasoning-output tokens are included in output, not an additional amount. These are recorded token counts, not billing or weekly quota estimates.

The observed workflow used an outer Codex monitor, a Sol coordinator, a planner, an implementer and a reviewer. Repeated model-driven status/sleep loops, copied approval packets, long retained chat history, broad document reads and duplicate handoff turns increased processing. Low thinking addressed only part of the cost. The compact status improvement reduces future response size but does not remove old history or eliminate those coordination turns.

Recommended priorities:

1. Use Luna/low for routine coordination; reserve Sol for difficult implementation and review. For small edits, use a single implementer and a bounded review rather than a planner plus persistent coordinator.
2. Compact the owner chat at settled objective boundaries before proposing another run. Prefer a short task brief and relevant source ranges; avoid carrying the complete earlier debugging transcript into every new objective.
3. Replace model-issued sleep/status polling with a local event monitor that reports meaningful transitions. Let the model act when a decision, correction, review or final handoff is needed. Reduce outer-monitor polling too.
4. Compact worker status/startup context and retrieve histories explicitly. Send a handoff after actual settlement through the runtime; deduplicate obsolete coordination messages without deleting evidence.
5. Expose recorded input/cache/output usage per role and add approved model-turn/token warning budgets. Preserve unknown usage and safe settlement rather than aborting commands or granting extra allowance automatically.

OpenAI's [pricing and usage guidance](https://learn.chatgpt.com/docs/pricing), checked on this date, explains that model choice, context, reasoning, tool use and caching affect allowance consumption, that extended sessions can use more per message, and that API pricing should not be used to estimate included subscription usage. Recommendations above are proposals; this audit did not change models, settings or runtime budgets.


## Six savings measures and context investigation

The owner authorized all six recommendations, then explicitly permitted direct
implementation without another swarm. Changes include Luna/low main defaults,
an approved single-implementer entry, settled-only `/swarm prepare`, native
`swarm_wait` and a local transition watcher, compact worker status/startup data,
and a durable per-worker usage ledger with opt-in request/token warning budgets.
See the package README for admission, overshoot, missing-usage and restart semantics.

A source and metadata check found **zero duplicate owner-mail deliveries** among
nine recorded owner-mail batches in the examined main chat. Its largest retained
tool outputs were file reads (357,808 characters), shell output (148,045), status
(84,572) and control (79,776). Growing retained tool history and model-driven
polling are established contributors; a duplicated-owner-mail defect was not
established.

A definite worker delivery bug was found: `pendingMail` included board messages,
but `buildTurnPrompt` filtered them out while the runtime could acknowledge their
IDs. The fix preserves board payloads and provenance before acknowledgment.
Repeated full worker boards (including candidate receipts/review bodies), approved
work and rolling status mail were also reduced. Human-facing status notifications
now show compact counts instead of full task records. Historical transcripts and
journals remain available; compact summaries do not certify execution or consent.

Reusable tools:

- [Transition watcher](../scripts/swarm-watch.mjs): local filesystem events,
  bounded lifetime, meaningful transitions only; no model calls.
- [Usage audit](../scripts/swarm-usage-audit.mjs): pass explicit native session
  files to compare input/cache/output counts, peak context and owner-mail duplicates.
  Copied histories can overlap and account quota cannot be attributed exactly.

### Deferred caching investigation

Treat deeper provider-prefix/cache behavior as a separate bounded task. Compare
captured provider-request prefixes and actual usage across ordinary owner input,
custom mail wakeups, mode hooks, compaction and model changes. Check stable system
instructions/tool definitions/session cache keys before changing SDK/provider code.
Measure cache-read fractions and uncached input for an equivalent workload; preserve
scope, current guidance, history, durable mail and approval identity.

The worker SDK intentionally disables **cache warming**, which prevents extra
background requests; that is not evidence that passive provider prompt caching is
disabled. Do not enable warming or rewrite old request-prefix messages merely to
claim better caching. Main mode hooks add instructions and custom wakeups follow a
different event path; this audit identified them for testing, not as a proven cache
bug. No provider cache-key, transport or native SDK patch was made in this task.


### Savings implementation verification

- Direct implementation was used; no new Pi swarm or third planner was launched
  for this work. The current Pi main model and tracked defaults are Luna/low.
- The new settled-only preparation command compacted the live owner chat from
  **112,902 tokens**. A subsequent five-token READY response on Luna recorded
  **26,469 input-context tokens**. This is observed context reduction (about 76.6%),
  not a controlled quota/cost comparison; no workers were started for the check.
- The complete package suite passed **756 tests**. SDK-focused checks also passed
  **129 tests**, including budget exhaustion after a final response, independent
  per-worker allowances, multi-request native compaction accounting, actual board
  payload delivery, and an admitted command finishing without being aborted when
  another worker reaches the model allowance. Missing/synthetic error usage remains
  unknown. All response observations are retained before the next gate/final flush.
- The final blocker-change wait regression passed three checks. Clone-completeness
  validation passed with a disposable index; the actual staging area was unchanged.
  Configuration fixtures passed 10 tests and shared checks passed 19. Managed entry,
  storage reload protection and terminal focus/composer checks passed on Linux/Pi
  1.0.4. No Windows, live unknown-command fault injection, or live multi-worker budget
  exhaustion test was performed. The model-request tests use the actual SDK with a
  local scripted provider, not additional charged model calls.
- New worker status/task pages and the local metadata audit/watcher were checked;
  unreadable watch input fails without asserting idle. Human-facing budget warnings
  occur once per state transition and do not inject model messages.
- Cold-start Pi after this extension upgrade; native leaf modules can survive
  `/reload`. The final cold start retains the same compacted owner chat and never
  automatically resumes the stopped team. No dependency upgrade or provider cache
  transport patch is part of these changes.


## Bounded caching audit completed — 2026-10-08

The [cache prefix audit](../guides/pi-cache-prefix-audit.md) found and fixed a
mode-extension bug: normal input forced a leading prompt that native mail wakes
skipped after the SDK cleared it. This changed the cacheable prefix and omitted
mode instructions on wakes, although hard tool restrictions remained enforced.
The correction consistently projects the owned mode section through the public
SDK request-context hook, preserving other instructions, tool declarations and
history. It does not freeze old policy when the owner changes mode or skill.

Actual SDK/provider serialization reproduced the defect offline before fixing it.
The complete mode suite passed 45 checks and 75 relevant Swarm checks passed.
Three successful Luna/low live replies then measured 0%, 94.9% and 94.6% cached
input respectively; the third was a native mail wake. Each reply used five output
tokens. Instruction/tool/settings/cache-key hashes and prior prefixes remained
stable. No workers, warming, SDK transport patches or extra normalization model
turns were used. These results demonstrate working reuse, not a quota/billing
forecast or a measured before/after savings estimate.

The guide and temporary diagnostic extension retain the method for future
regressions. Other sources of prefix changes, cache lifetime/routing and possible
performance tradeoffs remain separate evidence-driven investigations.


## Self-coordination and owner interface — 2026-10-10

The owner clarified that main should be the intermediary between the user and Swarm,
while workers coordinate execution themselves. Existing worker tools already supported
scoped tasks, claims, peer mail and recruitment; the missing runtime handoffs still made
candidate/review reports wake main for routine supervision.

- Worker and main tool instructions now assign routine decomposition, task selection,
  dependency handoffs, recruitment and review to Swarm. Main forwards steering and
  handles owner decisions, authorization questions and unresolved team blockers.
- A bounded scheduler offers suitable idle workers settled task/review handoffs, including
  dependent work after prerequisite acceptance and reviewer recruitment when necessary.
  It never grants assignments, clears blockers, releases unsettled ownership, overrides
  independent review or increases limits. An unchanged offered transition is not repeatedly
  woken when a worker declines; models still must choose and claim work correctly.
- Automatic candidate/review owner mail is removed. Explicit owner-addressed mail retains
  durable delivery; routine coordination belongs with peers/topic boards. Message purpose
  is instructed, not guessed from free text.
- Workers can request the existing final-check pipeline with `swarm_finish` after reviewed
  tasks cover the criteria. Execution waits for native turn settlement and current host
  admission, preserves Safety/receipt checks and pauses honestly on failure. Unexecuted
  final requests are local state and never replayed on restoration.
- A verified completion sends one bounded result to main, acknowledged only through the
  persisted native transcript. Candidate reports remain distinct from accepted completion.

Validation uses actual native Pi worker sessions with a scripted local provider, including
recruitment, two dependency-linked tasks, independent reviews and final verification with
one initial main dispatch and no owner-message relays. Negative checks cover premature
completion, failed final commands, independent Safety refusal, unavailable/busy reviewers,
unknown effects, blocked/exhausted work, repeated-transition suppression and delivery of
new owner steering before deferred verification. The full suite passed 767 checks before
final steering/blocker refinements, followed by 57 focused checks on the final runtime.
The final approval/main-chat integration checks passed 78 checks, including explicit
self-coordination and final-verification disclosure in the owner agreement. Portable
configuration validation and its ten fixture checks also passed. These are
runtime regression scenarios, not charged-model behavior measurements or a token-savings
forecast. Reload/cold restart is required before the active Pi process uses these changes.
