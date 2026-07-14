---
name: general-planning
plan-template: true
description: >-
  How to produce a genuinely good plan for any problem, in any domain, on any
  platform — merging the two halves of plan quality: decisive economy (commit to
  one approach, reuse what exists, degrade gracefully) and verified robustness
  (ground every claim in primary sources, design for lifecycle and failure, keep
  an honest risk ledger, verify executably). Use whenever asked to plan a
  feature, change, migration, investigation, or any nontrivial undertaking.
---

# General planning — how to write a plan that holds up

A plan is good when someone else could execute it **without redoing your research and
without re-making your decisions** — and without discovering mid-execution that a fact
was wrong, state evaporates on interruption, or a "revert" destroys more than it should.

This skill is distilled from comparing two independently written plans for the same
feature. Both were good — and good in *different* ways. One was an **architect's plan**:
decisive, economical, reuse-driven, easy to act on. The other was an **auditor's plan**:
every claim verified against primary sources, lifecycle and failure designed explicitly,
risks stated honestly, verification executable. Each style alone fails differently.
A great plan is deliberately both. That contrast is the core of this skill.

## The two halves of plan quality

### Half 1 — Decisive economy (the architect's virtues)

- **Confirmed requirements up front.** Elicit what the stakeholder actually wants,
  confirm it with them, and write it as a short numbered list before designing anything.
  Every later section traces back to these numbers.
- **Reuse before invention.** Find the closest existing thing — a prior feature, a
  proven pattern, an existing process — and anchor the plan to it: "this mirrors X, so
  most of the work is adapted rather than written fresh." New surface area is the most
  expensive thing a plan can propose.
- **One recommended approach, with the why inline.** Not a survey of options. Where a
  choice was made, state the reason in the same sentence ("X is the default because it
  isolates exactly what we need"), so the executor never has to guess intent.
- **Graceful-degradation chains for hard constraints.** When a dependency might be
  absent (a tool, a network, a permission, a person), design the fallback ladder
  explicitly: preferred path → fallback → last resort, and what is lost at each step.
- **Prove the hardest constraint end-to-end.** If one requirement is the reason the plan
  exists ("must work without X", "must finish in Y"), give it its own section walking
  every part of the design and showing the constraint holds everywhere — don't leave the
  reader to assemble the proof from fragments.
- **Economy.** Scannable structure, decision-dense prose, no padding. A plan nobody
  reads fully is a plan nobody follows fully.

### Half 2 — Verified robustness (the auditor's virtues)

- **Ground every factual claim in a primary source.** Read the actual contract — the
  spec, the interface definition, the documentation, the system itself, the person who
  owns the process — not your memory of it. Cite precisely (file and line, document and
  section, name and date) so the reader can re-verify. A plan built on an interface,
  tool, rule, or resource that doesn't exist as described fails at execution time, when
  it is most expensive.
- **Inventory before inventing.** For each capability the design needs, check whether
  the platform, organization, or environment already provides it before proposing new
  machinery or an outside dependency.
- **Design the lifecycle.** What survives interruption, restart, handover, resumption?
  Where does state live and how is it rebuilt? Anything held only "in memory" — in a
  process, in one person's head, on a whiteboard — silently dies; say what persists it.
- **Two-phase where things can fail.** Wherever there's a gap between "about to happen"
  and "happened", capture intent first and commit only on confirmed success, with
  cleanup for the never-happened case. Acting on intent alone corrupts your record of
  reality.
- **Safety on destructive or irreversible steps.** Confirmation gates; drift detection
  (has the target changed since we last looked?); abort-on-ambiguity rather than
  guess-and-proceed; and **precision** — a rollback must undo exactly what was done and
  nothing more (a revert that also wipes someone else's work is a new incident, not a
  fix).
- **Least privilege.** Any delegated actor — a helper process, a subcontractor, an
  automated job — gets the minimum access its task needs.
- **An honest risk ledger.** Every unverified behavior, scaling concern, and deferred
  decision, each with a disposition: "verify during execution", "mitigated by X", or
  "out of scope — follow-up". Findings and assumptions never share a sentence.
- **Executable verification.** A numbered script a stranger can run step by step —
  not "test that it works".

### Why you need both — the failure modes of each half alone

| A decisive plan without verification | A verified plan without decisiveness |
|---|---|
| Cites interfaces/rules from memory — some don't exist as described | Surveys options without committing; defers the real decisions to the executor |
| Reinvents or shells out to external machinery the platform already provides | So exhaustive nobody reads it end to end |
| Keeps critical state somewhere that dies on interruption | Buries the recommended path under caveats |
| Rollback broader than the change ("restore everything" instead of "restore what *we* did") | Proves each fact but never assembles the end-to-end argument for the hard constraint |
| Reads beautifully; breaks during execution | Verifies beautifully; never gets executed as written |

**Drive this home in your own plans:** after drafting, ask which plan you wrote — then
add the other half.

## Method

### Phase 0 — Requirements
Elicit, disambiguate, and confirm what is actually wanted. Ask about scope boundaries,
hard constraints, and what "done" means. Write the confirmed requirements as a numbered
list; get explicit agreement before designing.

### Phase 1 — Research (before any design)
1. Read primary sources for every fact the design will lean on; record citations.
2. Inventory existing assets: utilities, prior art, processes, people. Classify what
   you'll take as **copy / adapt / new**, and from where.
3. Verify lifecycle behavior (what survives interruption) by observation or source, not
   assumption. What you can't verify goes straight into the risk ledger.
4. Keep two piles as you go: *verified* and *assumed*. They never mix.

### Phase 2 — Design
One subsection per requirement or mechanism. For each: the chosen approach and its why;
state and persistence; ordering and two-phase commit where failure can intervene;
failure and empty states; safety and precision for anything destructive; least privilege
for anything delegated; fallback chains for anything that might be absent. For any
interface humans touch (a UI, a form, a runbook), a mockup or a table of
inputs → actions beats prose.

### Phase 3 — Write the plan (required sections, in order)
1. **Context** — the problem, why now, and the numbered confirmed requirements.
2. **Grounded key findings** — the verified facts, organized by concern, each cited.
3. **Design** — as above; include the dedicated end-to-end section for the hardest
   constraint.
4. **Deliverables** — every artifact with a one-line summary and provenance
   (new / copied from where / adapted from where).
5. **Changes beyond the deliverable** — registration, configuration, documentation,
   announcements, index updates.
6. **Risks & open questions** — the honest ledger, each item with a disposition.
7. **Verification** — the numbered end-to-end script: every requirement; every
   environment variant; edge cases (first run, interruption/resume, external change to
   things you track, missing/deleted targets, oversized/degenerate input, concurrency,
   empty sets); every destructive path and its gate; cleanup checks (nothing orphaned,
   nothing leaked).

### Phase 4 — Self-review checklist
- [ ] No invented facts: every claim traceable to a primary source examined during
      this planning effort, with citation.
- [ ] Each numbered requirement maps to ≥1 design subsection and ≥1 verification step.
- [ ] Reuse sweep done: nothing proposed that the platform/organization already provides.
- [ ] One committed approach per decision, with its why stated inline.
- [ ] Hardest constraint has its own end-to-end proof section.
- [ ] Fallback ladder exists for every dependency that might be absent.
- [ ] Lifecycle answered: what survives interruption/restart/handover, and how.
- [ ] Every destructive action is gated, drift-checked, and precise.
- [ ] Delegated actors run at least privilege.
- [ ] Risk ledger is non-empty — an honest plan has open questions.
- [ ] The plan is short enough to be read fully and complete enough to be executed
      without redoing the research. If forced to choose, split detail into appendices —
      never cut the decisions or the verification.
- [ ] Final gut check: did I write the architect's plan or the auditor's plan?
      Add the missing half.
