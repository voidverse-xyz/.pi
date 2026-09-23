---
name: decision-by-decision-planning
description: Build and maintain an implementation or design plan through a calm, topic-by-topic decision process. Use whenever the user wants to discuss a feature or refactor one decision at a time, says “next topic” during an ongoing planning discussion, wants agreed choices immediately saved into an evolving plan, or asks to avoid an overwhelming all-at-once planning interview. This skill complements software-implementation-planning by controlling the collaborative decision cadence.
---

# Decision-by-decision planning

Turn an ambiguous feature, refactor, migration, or architecture discussion into a durable plan without overwhelming the user. Discuss one consequential topic at a time, obtain an explicit decision, immediately update the plan, then move to the next topic.

Use the repository's normal planning skill or conventions for technical research and final plan quality. This skill governs the collaboration loop rather than replacing repository research.

## Summary

Maintain one evolving plan and distinguish proposals from agreements. Immediate file updates apply only when the current instructions and tools permit them.

## Details

### Scope and save boundaries

This is a collaboration skill, not a `plan-template: true` template for Pi's `/plan` router. Invoke it through normal skill discovery or `/skill:decision-by-decision-planning`; do not pass it to `/plan --skill`.

- In unrestricted mode, update the plan file after each agreement, respecting project instructions and preserving unrelated edits.
- Host-managed Plan mode and the base `pi-plan-mode` skill take precedence over this skill's save cadence. Do not use ordinary edit/write tools there; save only the complete final plan through authorized `save_plan` when those boundaries permit it.
- In Discuss, Quick, direct `/skill:pi-plan-mode`, or any other read-only context, keep the evolving decisions in chat and state that they are not saved. Do not bypass restrictions or change modes yourself to persist them.
- If a write is blocked or fails, retain the agreed change in chat, report the failure, and do not say the file was updated.

## Core contract

Follow this loop:

1. Research enough of the current implementation to discuss the next real decision accurately.
2. Select one unresolved topic whose answer constrains later topics.
3. Explain only that topic, its important tradeoff, and one recommended choice.
4. Let the user question, reshape, or reject the recommendation.
5. Treat a choice as settled only after the user explicitly agrees or states the decision directly.
6. Immediately incorporate the settled decision into the evolving plan, saving it only as permitted by the scope and save boundaries above.
7. Confirm briefly that the plan was updated.
8. Present the next unresolved topic only when requested or when the conversation clearly calls for it.

The rhythm should feel like:

```text
one topic -> discussion -> agreement -> plan update -> next topic
```

## Start the planning session

Before presenting decisions:

- Read applicable repository instructions and the relevant planning skill.
- Trace enough of the current architecture to avoid proposing nonexistent interfaces or duplicating existing behavior.
- Locate an existing plan if the user refers to one; otherwise choose the repository's established plan location. If no convention exists, use a suitable project-local planning category such as `.agents/plans/`, not the shared library. Check the project index first and keep a newly saved plan discoverable there when applicable.
- Create a concise initial plan only after there is at least one settled decision worth preserving.
- Record verified facts separately from proposed or agreed design choices.

If the user already has a live discussion and asks to turn the process into this workflow, extract decisions from conversation history rather than asking them to repeat context.

## Choose the next topic

Prefer dependency order:

1. Goal, scope, and non-goals.
2. Data ownership and durable schema.
3. Identity, authorization, and privacy.
4. Lifecycle and timing.
5. Interfaces and integration boundaries.
6. Failure, retry, degraded, and recovery behavior.
7. Read paths and user-visible behavior.
8. Migration, retention, rollout, and rollback.
9. Performance constraints.
10. File-level implementation and verification.

Adapt this order to the task. Pick the smallest topic that still represents a meaningful decision. Do not bundle five independent decisions into one response merely because they are related.

When the user says “next,” first ensure the preceding agreement is recorded (and saved when permitted), then choose the most foundational unresolved topic.

## Discuss one topic well

Keep each topic focused:

- State the decision in plain language.
- Explain why it matters.
- Recommend one option when evidence supports it.
- Show a compact schema, payload, flow, or example when concrete structure helps.
- Mention only tradeoffs that could change the choice.
- Ask one focused question or wait for agreement.

Avoid long checklists of every future decision. If useful, name the next few topics briefly, but discuss only one in depth.

If the user says the response is too detailed, reduce the unit of discussion immediately. Preserve the substance in the plan, not in a long chat response.

## Distinguish proposal from decision

Use these states consistently:

- **Verified fact:** confirmed in code, documentation, or the environment.
- **Proposal:** recommended but not accepted.
- **Agreed decision:** explicitly accepted or directly stated by the user.
- **Deferred:** intentionally postponed with a reason or sequencing condition.
- **Open:** still requires a decision.

Never write a proposal into the plan as though it were agreed. When the user corrects an assumption, update both the conversation model and the plan; do not keep defending the earlier proposal.

Phrases such as “agree,” “okay, next,” “that works,” or a direct replacement decision normally settle the current topic. If “okay” is genuinely ambiguous, confirm instead of guessing.

## Update the plan immediately

After agreement:

- Edit the existing plan rather than creating scattered decision notes.
- Preserve prior settled decisions unless the user intentionally changes them.
- Replace superseded wording so the plan has one current truth, not a chronological transcript.
- Record the rationale only when it helps an implementer avoid reopening the decision.
- Add consequences to schema rules, lifecycle behavior, compatibility, and verification where relevant.
- Remove stale “unresolved” statements once a decision settles them.
- Keep deferred work clearly labeled and do not repeatedly resurface it before its agreed sequence point.

A plan update should usually include:

```markdown
## [Relevant section]

- Agreed behavior.
- Important invariant or boundary.
- Failure or empty-state meaning.
- Verification evidence required.
```

Do not claim the plan was updated unless the file write succeeded.

## Maintain plan coherence

After edits, check affected sections and cross-references for coherence. Review the complete plan before implementation or when targeted checks cannot establish consistency. Check for:

- Old statements contradicted by newer decisions.
- A field or interface shown differently in multiple examples.
- Deferred work accidentally described as finalized.
- Verification steps that no longer match the design.
- Duplicate sections created by incremental editing.
- Assumptions presented without a source or decision.

Prefer surgical edits during discussion, followed by a coherence pass before implementation.

## Handle deferred topics

When the user postpones a topic:

- Record what is deferred.
- Record why it is deferred and what must happen before returning to it.
- Define a stable boundary so surrounding work does not depend on the eventual choice.
- Move to a different topic instead of continuing to design the deferred area.

Example:

```markdown
TURN collection internals are deferred until the ingestion contract is implemented.
The collector must satisfy `collectStatistics()` regardless of its eventual data source.
```

## Handle destructive decisions

For deletion, migration, cleanup, or irreversible rollout choices:

- Confirm the user's authorization explicitly.
- Identify related state such as obsolete indexes, writers, caches, and rollback limitations.
- Put destructive work in an explicit migration or deployment step, not ordinary startup.
- Require execution-time target verification and confirmation.
- Preserve unrelated data.

Agreement in a design discussion authorizes documenting the operation, not executing it immediately unless the user separately asks for execution.

## Know when planning is sufficient

When asked whether topics remain:

1. Reread the plan.
2. List only material unresolved or deliberately deferred decisions.
3. Separate blockers from implementation details that can safely follow repository conventions.
4. Do not invent more discussion merely to prolong the process.

Planning is sufficient when another engineer can implement the agreed scope without reopening consequential product or architecture choices. Deferred later-stage work may remain if the plan defines a stable boundary and sequencing condition.

Before implementation, perform a final pass using the repository's software implementation planning standard: verified file references, file-level changes, lifecycle, failure behavior, migration/rollback, and executable verification.

## Communication style

- Keep chat responses concise and conversational.
- Discuss one meaningful topic at a time.
- Lead with the recommendation, not a wall of alternatives.
- Do not use a multi-question interview unless the user requests faster batch planning.
- Confirm plan updates in one sentence.
- Respect “for now” decisions and explicitly mark advanced behavior as deferred.
- If the user asks to keep something simple, choose the smallest coherent initial behavior and document later optimizations as non-goals.
