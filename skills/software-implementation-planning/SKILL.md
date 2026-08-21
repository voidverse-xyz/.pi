---
name: software-implementation-planning
plan-template: true
description: Produce a decision-complete implementation plan for a software feature, refactor, migration, integration, or extension. Use when code changes need repository research, verified interfaces, file-level design, lifecycle and failure behavior, risks, and executable verification.
---

# Software implementation planning

Write a plan another engineer or agent can implement without rediscovering the architecture or inventing missing decisions. Scale the plan to the change; a focused refactor should not receive a platform-migration document.

## Confirm the real requirements

Extract requirements already present in the request. Investigate discoverable facts yourself and ask only about choices that materially affect behavior, compatibility, safety, or scope.

Record:

- User-visible behavior and acceptance criteria.
- Compatibility, performance, security, and operational constraints.
- Explicit non-goals.
- Migration or rollback expectations when state changes.

Do not add a confirmation round merely to restate a clear request.

## Research the repository

Before designing:

1. Read applicable project instructions.
2. Trace the current implementation through its entry points, interfaces, state, and tests.
3. Find the closest existing feature or pattern to reuse.
4. Read actual types, schemas, APIs, and dependency documentation for every contract the plan names.
5. Record exact `file:line` citations for findings that drive the design.

Never design around a symbol, flag, event, endpoint, or tool inferred only from memory. Label anything not verified as an assumption or implementation-time check.

## Choose one design

Recommend one approach and explain the important tradeoffs. Avoid leaving routine architectural decisions to the implementer.

Cover only the dimensions relevant to the change:

- Files and responsibilities.
- Public interfaces, request/response shapes, and compatibility.
- Data ownership, persistence, caching, and migration.
- Initialization, shutdown, reload, retry, cancellation, and cleanup.
- Ordering and success boundaries around fallible operations.
- Authorization, privacy, and least privilege.
- Error, empty, degraded, and recovery states.
- Concurrency, idempotency, or drift where they can affect correctness.

Reuse project utilities before adding dependencies or external commands. Before destructive or difficult-to-reverse operations, require explicit authorization, detect whether the target drifted since inspection, and abort rather than guess when the intended inverse is ambiguous. Define rollback narrowly so it restores only this change's effects and preserves unrelated user data.

## Describe file-level implementation

List each file to create or modify with:

- Its role in the design.
- The existing source or pattern it follows.
- Key symbols or contracts changed.
- Tests or callers affected.

Do not invent files solely to make the plan look complete. Keep documentation and configuration changes tied to real implementation needs.

## Make verification executable

Provide an ordered verification sequence:

1. Focused automated tests.
2. Type, lint, build, or schema checks that apply.
3. Integration checks across changed boundaries.
4. Manual behavior checks only where automation is impractical.
5. Migration, rollback, restart, cleanup, or failure-path checks when relevant.

State expected evidence, not just commands. Include environment variants and edge cases only when the feature supports them.

## Recommended output

1. **Requirements and scope**
2. **Verified findings** with `file:line` citations
3. **Implementation design**
4. **File changes**
5. **Interfaces, state, and lifecycle**
6. **Failure and compatibility behavior**
7. **Risks or unresolved decisions**
8. **Verification sequence**

Omit empty sections. Keep risks honest rather than forcing a non-empty ledger.

## Final review

Check that:

- Every important API claim was verified in source.
- Existing patterns and utilities were considered first.
- The design commits to one implementable approach.
- State ownership and lifecycle are explicit where relevant.
- Failures and destructive actions preserve unrelated work.
- Every requirement maps to implementation and verification.
- The plan is concise enough to execute without another planning pass.
