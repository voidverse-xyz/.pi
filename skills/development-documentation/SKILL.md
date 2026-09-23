---
name: development-documentation
description: Create, revise, or review implementation-ready software documentation such as technical specifications, architecture decision records, migration proposals, API documentation, and operational runbooks. Use when a development document must capture verified repository context, decisions, interfaces, rollout or failure behavior, ownership, and validation. Do not use for general business writing, marketing content, or routine code comments.
---

# Development Documentation

Produce documents that let engineers make decisions, implement changes, operate
systems, or review risk without relying on hidden conversational context.

## Establish the document contract

Determine before drafting:

- document type and decision or action it must enable,
- intended readers and assumed knowledge,
- current state, desired state, and scope boundary,
- authoritative template or repository convention,
- owner, reviewers, status, and review deadline when relevant,
- facts that require repository or source verification,
- sensitive details that must not enter a committed or external artifact.

Extract known answers from the conversation first. Ask only for consequential
missing information. If the repository provides a template, use it rather than
imposing this skill's generic structure.

## Research before asserting

For system-specific documents, inspect the implementation, configuration, tests,
schemas, and existing documentation. Trace important claims to current sources.
Distinguish:

- **verified fact** — supported by code, configuration, tests, or an authoritative
  source,
- **decision** — chosen direction and rationale,
- **proposal** — not yet approved or implemented,
- **assumption** — plausible but unverified,
- **open question** — blocks or may alter the design.

Do not present inferred behavior as current behavior. Use paths and symbols when
they help readers verify a claim, but avoid brittle line numbers unless the
artifact requires them.

## Choose the document type

Use the closest template in [document templates](references/templates.md):

- **Technical specification** — defines an implementable software change.
- **Architecture decision record (ADR)** — records one consequential decision,
  its context, alternatives, and consequences.
- **Migration proposal** — defines a safe transition between states, including
  compatibility, rollout, rollback, and cleanup.
- **API documentation** — defines a consumer-facing contract and examples.
- **Operational documentation** — explains how to observe, operate, troubleshoot,
  and recover a system.

Combine types only when readers genuinely need one artifact. For example, a large
migration may link to an ADR rather than embedding the entire decision history.

## Draft for implementation and review

Create the smallest structure that covers the document's decision. Prefer precise
headings, tables for comparable items, and examples for contracts or workflows.

Every consequential proposal should answer:

1. What problem and evidence justify the work?
2. What is in scope and explicitly out of scope?
3. How does the current system behave?
4. What will change, and where is responsibility assigned?
5. What interfaces, data, states, or invariants are affected?
6. How do failures, retries, cancellation, and partial completion behave?
7. How will compatibility and migration be handled?
8. How will the result be tested, observed, rolled out, and rolled back?
9. Which risks, alternatives, assumptions, and open questions remain?
10. What constitutes completion?

Omit questions that truly do not apply; do not fill sections with generic prose.

## Type-specific requirements

### Technical specification

Make the design decision-complete enough for implementation planning. Name
affected components and ownership boundaries, describe state and data flow, define
interfaces and failure contracts, and connect acceptance criteria to verification.
Do not turn the document into a file-by-file task list unless implementation
planning is part of the request.

### Architecture decision record

Record one decision in a durable form. State the context and forces, the decision,
seriously considered alternatives, and positive and negative consequences. Give
status and date using repository conventions. Do not rewrite history after the
decision changes; supersede the ADR and link both records.

### Migration proposal

Define source and target states, affected populations, dependency ordering,
coexistence or compatibility windows, backfill/data validation, progressive
rollout gates, abort thresholds, rollback feasibility, and legacy cleanup.
Separate reversible deployment steps from irreversible data changes. Assign
owners for high-risk steps.

### API documentation

Describe the observable contract rather than internal implementation. Include
authentication/authorization, requests, responses, error semantics, idempotency,
pagination or streaming behavior, rate or size limits, versioning, compatibility,
and realistic examples as applicable. Verify examples against schemas or tests
when possible. Never include live credentials or private production data.

### Operational documentation

Optimize for use during real operations. State prerequisites and permissions,
service health indicators, dashboards or queries, common symptoms, diagnostic
steps, mitigations, escalation, recovery, and post-recovery verification. Mark
risky or destructive actions, expected output, and stop conditions. Avoid commands
that assume one shell or operating system unless the system itself requires it.

## Collaborate efficiently

Draft in coherent sections rather than forcing a fixed interview or a large
brainstorming ritual. Use the interaction style appropriate to the situation:

- For a well-specified request, produce a complete draft and identify gaps.
- For an ambiguous high-impact decision, resolve choices topic by topic.
- For an existing document, preserve its voice and structure while making
  targeted edits.
- When the user supplies exact policy or decision language, preserve it unless
  asked to edit it.

Use available file-editing tools to update the actual document. Do not require a
browser, special artifact system, connected document service, or subagent. If
those capabilities exist, use them only when they improve the task and respect
permissions.

## Review from four perspectives

Before completion, review the whole document for:

### Correctness

- Claims match current code and sources.
- Examples agree with the described contract.
- Proposed behavior does not contradict itself.
- Unknowns and assumptions are labeled.

### Decision completeness

- A reader can tell what was chosen and why.
- Boundaries, ownership, dependencies, and failure behavior are explicit.
- Migration, rollout, rollback, and observability are covered where relevant.
- Acceptance criteria are verifiable.

### Reader usability

- The title and opening state purpose and status.
- Terms and acronyms are defined for the intended audience.
- Important decisions are easy to find.
- Repetition and generic filler are removed.
- Links and references resolve in the target environment.

### Safety and maintenance

- No secrets, private data, or unsafe copy-paste commands are exposed.
- Destructive steps require confirmation and recovery guidance.
- Owners and update triggers are identified for living documentation.
- Temporary states and legacy cleanup have explicit end conditions.

A fresh reviewer or isolated agent may be used when available, but it is optional.
Provide it only the document and necessary non-sensitive context. Manual review is
a valid fallback.

## Complete the work

Deliver the document at the requested path or in the requested system. Report:

- what was created or changed,
- important decisions captured,
- sources verified,
- unresolved assumptions or questions,
- checks performed and anything not verified.

Do not call a document implementation-ready when unresolved choices still affect
interfaces, data safety, compatibility, or operational recovery.
