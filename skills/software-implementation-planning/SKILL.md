---
name: software-implementation-planning
plan-template: true
description: Author software implementation plans that hold up in execution — requirements confirmed and numbered, every API claim verified in real source with file:line citations, reuse before invention, lifecycle and failure designed explicitly, destructive operations made safe and precise, an honest risk ledger, and a numbered end-to-end verification script. Use whenever writing an implementation or design plan for a feature, refactor, migration, extension, or any nontrivial code change.
---

# Software implementation planning

An implementation plan is good when another engineer (or agent) could execute it
**without redoing your research and without re-making your decisions** — and without
discovering mid-build that an API doesn't exist, state evaporates on restart, or a
rollback destroys more than it should.

Plan quality has two halves, and most plans have only one. The **architect's half**:
decisive, economical, reuse-driven — easy to act on. The **auditor's half**: every claim
verified against real source, lifecycle and failure designed, risks stated honestly —
safe to act on. A decisive plan on unverified facts reads beautifully and breaks during
execution; a verified plan without committed decisions and economy never gets executed
as written. Write both halves on purpose. After drafting, ask which plan you wrote —
then add the other half.

## The architect's half — decisive economy

- **Confirmed requirements up front.** Elicit scope boundaries, hard constraints
  (environments, offline/no-repo cases, performance, compatibility), and what "done"
  means. Write them as a short numbered list and confirm before designing. Every later
  section traces back to these numbers.
- **Reuse before invention.** Find the closest existing feature in the codebase and
  anchor to it: "this mirrors `<path>`, so most rendering/plumbing is adapted rather
  than written fresh." Classify every piece as **copy / adapt / new** — new code is the
  most expensive thing a plan can propose.
- **One committed approach, why inline.** No option surveys. Where a choice was made,
  state the reason in the same sentence ("baseline diff is the default because it
  isolates exactly the agent's edits"), so the implementer never guesses intent.
- **Fallback ladders for absent dependencies.** When a binary, network, repo, service,
  or permission might be missing: preferred path → fallback → last resort, with what
  degrades at each step — designed, not discovered.
- **Prove the hardest constraint end-to-end.** If one requirement is why the plan exists
  ("must work without git", "must handle 10k rows", "zero downtime"), give it a
  dedicated section walking every mechanism and showing the constraint holds everywhere.
- **Economy.** Scannable headings, decision-dense prose, tables over paragraphs. A plan
  nobody reads fully is a plan nobody follows fully.

## The auditor's half — verified robustness

- **Read the real contracts, not your memory.** Type definitions (`.d.ts`, headers,
  schemas), the dependency's actual source, in-repo docs. Every symbol, field, event,
  flag, and endpoint named in the plan must have been seen in a real file during this
  planning effort — cite `file:line` so the reader can re-verify in seconds. Invented
  APIs and wrong field names are the most common way good-looking plans die.
- **Platform-utility sweep.** For each capability the design needs (diffing, locking,
  persistence, highlighting, spawning, retries), search the SDK and codebase first.
  Never shell out to an external binary or hand-roll machinery the platform exports.
- **Design the lifecycle.** What survives process restart, config reload, session
  resume, crash? Module-scoped in-memory state silently dies; say where durable state
  lives (disk, session log, DB) and how it's rebuilt on startup — and verify the
  persistence mechanism exists by reading it.
- **Two-phase around fallible operations.** Wherever there's a gap between "about to
  happen" and "happened" (a before-hook vs. a result event, a request vs. a response),
  stage on intent and commit only on confirmed success (`!isError`), with cleanup for
  the never-completed case. Acting on intent alone corrupts tracked state.
- **Destructive-operation safety.** Four rules: a confirmation gate; **drift detection**
  (hash or mtime — has the target changed outside your control since you last recorded
  it?); **abort-on-ambiguity** (if an inverse operation doesn't match exactly once,
  refuse rather than guess); and **precision** — undo exactly what was done and nothing
  more. `git checkout HEAD -- <file>` as an undo reverts the user's edits along with
  yours; a captured pre-image restores only yours.
- **Least privilege.** Spawned child processes, CI jobs, and delegated agents get the
  minimum toolset/permissions their task needs (a reviewer child gets read-only tools,
  not the full set).
- **Verified vs. assumed, never mixed.** Findings you read and behaviors you're guessing
  at never share a sentence. What you couldn't verify goes in the risk ledger with
  "verify during implementation".
- **Executable verification.** A numbered script, not "test that it works".

## Failure modes to catch in review (each seen in real plans)

| Weak plan | Strong plan |
|---|---|
| Cites `input.file_path` from memory; designs around a tool that doesn't exist | Cites `EditToolInput { path, edits }` at `core/tools/edit.d.ts:12` |
| Shells out to `git diff --no-index` with temp files | Found the SDK's own `generateUnifiedPatch` export — no git dependency at all |
| Baselines in a module-scoped `Map` (lost on reload/resume) | Baselines persisted to the session log, rebuilt on `session_start` |
| Captures state on the before-event only | Stages on before-event, commits on result event when `!isError`, clears pending on turn end |
| Undo = `git checkout HEAD -- <path>` (reverts user's work too) | Byte-exact pre-image restore + sha256 drift warning + delete-confirm for created files |
| Child helper spawned with full toolset | Child spawned with `read,grep,find,ls` only |
| "Verify the feature works" | 20 numbered steps incl. resume, reload, drift, orphan-process and temp-file checks |
| No risks section — assumptions read as facts | Risk ledger: unverified event ordering, session-file growth, encoding — each with a disposition |

## Method

### Phase 0 — Requirements
Elicit and disambiguate; confirm with the requester; write the numbered list. Include
environment variants (git and non-git, online and offline, interactive and headless)
and explicit non-goals.

### Phase 1 — Research (before any design)
1. Read the contracts: type definitions, source, docs for everything you'll touch.
   Record `file:line` citations as you go.
2. Sweep for existing utilities and the closest prior-art feature; classify
   copy / adapt / new, with source paths.
3. Verify lifecycle and event-ordering behavior by reading the code, not assuming.
4. Keep two piles — *verified* and *assumed*. The assumed pile becomes the risk ledger.

### Phase 2 — Design
One subsection per requirement/mechanism, each covering: the chosen approach and its
why; state & persistence; ordering/two-phase where failure can intervene; failure and
empty states (missing, binary, oversized, concurrent, mid-flight, first-run); safety
and precision for anything destructive; least privilege for anything spawned; fallback
ladders for anything that might be absent. For UI: an ASCII mockup and a key/action
table beat prose. Include the dedicated end-to-end section for the hardest constraint.

### Phase 3 — Write the plan (required sections, in order)
1. **Context** — the problem, why now, numbered confirmed requirements, non-goals.
2. **Grounded key findings** — verified APIs, events, types, prior-art patterns,
   organized by concern, every claim with a `file:line` citation.
3. **Design** — as above.
4. **File tree** — every file with a one-line contents summary and provenance:
   **new** / **copied from `<path>`** / **adapted from `<path>`**.
5. **Changes outside the deliverable** — registration, config, docs, indexes, CI.
6. **Risks & open questions** — every unverified behavior, scaling concern, and
   deferred decision, each with a disposition: "verify during implementation",
   "mitigated by X", or "out of scope — follow-up".
7. **Verification** — a numbered end-to-end script an implementer can execute:
   automated gates first (typecheck, lint, tests), then manual steps covering every
   requirement, every environment variant, edge cases (first run, restart/resume,
   external mutation of tracked state, deleted/missing targets, binary/oversized input,
   concurrency, empty sets), every destructive path and its confirmation gate, and
   cleanup checks (no orphan processes, no leftover temp files).

### Phase 4 — Self-review checklist
- [ ] No invented APIs: every symbol traceable to a file read this session, with citation.
- [ ] Each numbered requirement maps to ≥1 design subsection and ≥1 verification step.
- [ ] Platform-utility sweep done: nothing hand-rolled or shelled-out that the SDK or
      codebase already provides.
- [ ] Reuse classified: every file marked new / copied / adapted, with source paths.
- [ ] One committed approach per decision, why stated inline — no option surveys.
- [ ] Hardest constraint has its own end-to-end proof section.
- [ ] Fallback ladder exists for every dependency that might be absent.
- [ ] Lifecycle answered: what survives restart/reload/resume, where it persists, how
      it's rebuilt.
- [ ] Fallible operations are two-phase (stage on intent, commit on success, clean up
      the never-happened case).
- [ ] Every destructive action is gated, drift-checked, abort-on-ambiguity, and precise.
- [ ] Spawned processes/jobs run at least privilege.
- [ ] Risk ledger is non-empty — an honest plan has open questions, each with a
      disposition.
- [ ] Verification is numbered and executable by a stranger, ending with cleanup checks.
- [ ] Short enough to read fully, complete enough to execute without redoing the
      research. If forced to choose, move detail to appendices — never cut decisions or
      verification.
- [ ] Gut check: architect's plan or auditor's plan? Add the missing half.
