# Development document templates

Adapt these structures to repository conventions. Remove sections that do not
apply rather than filling them with boilerplate. Add status, owner, reviewers,
and dates when the repository expects document metadata.

## Technical specification

```markdown
# <Change name>

## Summary
What changes, for whom, and the intended outcome.

## Problem and evidence
Current limitation, user/system impact, and supporting evidence.

## Goals and non-goals
Explicit success boundary.

## Current system
Relevant components, data flow, constraints, and verified source references.

## Proposed design
Responsibilities, state transitions, data flow, and important algorithms.

## Interfaces and contracts
APIs, events, schemas, configuration, permissions, and compatibility promises.

## Failure and recovery behavior
Validation, errors, retries, timeouts, cancellation, partial completion, and
reconciliation.

## Data and migration
Schema changes, backfills, coexistence, validation, retention, and rollback.

## Security, privacy, and abuse considerations
Trust boundaries, sensitive data, authorization, and misuse risks.

## Observability and operations
Signals, logs, metrics, alerts, dashboards, support, and ownership.

## Rollout and rollback
Stages, gates, abort thresholds, rollback steps, and cleanup.

## Verification and acceptance criteria
Tests and observable conditions that prove the design works.

## Alternatives and trade-offs
Seriously considered choices and why they were not selected.

## Risks, assumptions, and open questions
Uncertainty, mitigation, owner, and resolution deadline where applicable.
```

A strong technical specification lets reviewers identify the affected contracts
and lets implementers proceed without inventing core behavior.

## Architecture decision record

```markdown
# ADR-<number>: <Decision title>

- Status: proposed | accepted | deprecated | superseded
- Date: <date>
- Deciders: <people or roles>
- Supersedes / Superseded by: <links when applicable>

## Context
The forces, constraints, and evidence that require a decision.

## Decision
The selected direction in concrete, testable language.

## Alternatives considered
Options evaluated, including the status quo, with material pros and cons.

## Consequences
Benefits, costs, risks, operational effects, and future constraints.

## Follow-up
Required implementation, documentation, review, or reassessment work.
```

An ADR records why a decision was reasonable at the time. If the decision later
changes, create or follow the repository's superseding record rather than erasing
its original context.

## Migration proposal

```markdown
# <Migration name>

## Summary and motivation
Source state, target state, reason, and affected users or systems.

## Scope and inventory
Systems, data sets, tenants, environments, and owners included or excluded.

## Preconditions
Capacity, backups, tooling, compatibility, permissions, and validation readiness.

## Compatibility strategy
Dual-read/write, adapters, version windows, feature flags, or required downtime.

## Migration phases
For every phase: change, owner, prerequisites, verification, rollout gate, abort
threshold, rollback, and estimated exposure.

## Data movement and validation
Backfill or transformation method, idempotency, reconciliation, sampling, and
source/target consistency checks.

## Failure scenarios
Partial progress, retries, stale writers/readers, dependency failure, and recovery.

## Observability and communication
Dashboards, alerts, progress reporting, support plan, and stakeholder notices.

## Rollback and roll-forward
What is reversible, what is not, decision authority, and recovery time/data loss.

## Legacy cleanup
Deletion criteria, retention obligations, owner, and earliest safe removal point.

## Acceptance criteria
Conditions for phase completion and final migration completion.

## Risks and open decisions
Severity, likelihood, mitigation, owner, and due date.
```

Do not describe “rollback” as available when an irreversible schema or data
transformation makes only roll-forward recovery possible.

## API documentation

```markdown
# <API or operation>

## Purpose and lifecycle
Consumer outcome, stability/status, version, and deprecation policy.

## Endpoint or operation
Method and path, RPC name, event topic, function signature, or command syntax.

## Authentication and authorization
Required identity, scopes/roles, tenant boundaries, and permission failures.

## Request
Parameters, headers, body/schema, defaults, limits, validation, and example.

## Response
Success status, schema, field semantics, ordering, and example.

## Errors
Stable error identifiers/statuses, meanings, retryability, and corrective action.

## Behavioral contract
Idempotency, concurrency, consistency, pagination, streaming, timeouts, and side
effects as applicable.

## Compatibility and versioning
Change policy, deprecated fields, supported clients, and migration guidance.

## Limits and operations
Rate/size limits, quotas, observability identifiers, and support/escalation path.
```

Examples should be executable or testable when practical and must use synthetic
values instead of real credentials or production data.

## Operational runbook

```markdown
# <Service or incident condition>

## Purpose and ownership
When to use this runbook, service owner, and escalation contact/rotation.

## Preconditions and safety
Required access, environment selection, backups, approvals, and destructive-step
warnings.

## Symptoms and impact
Observable signals, affected functions/users, and severity guidance.

## Initial assessment
Health checks, dashboards, logs, traces, queries, and expected healthy output.

## Diagnosis
Ordered decision points that narrow likely causes; include stop/escalate conditions.

## Mitigation
Lowest-risk actions first. For each action: expected result, verification, risk,
and reversal.

## Recovery
Restore normal operation, reconcile state, and validate user-visible behavior.

## Escalation
When, why, and to whom to escalate; information to collect first.

## Post-recovery
Monitoring window, incident/update requirements, follow-up work, and runbook gaps.
```

Commands must state the target environment and expected outcome. Prefer
read-only diagnostics before mutations. Never make a dangerous action look like a
routine copy-paste step.

## Cross-document review prompts

Use these questions during review:

- Which statement would an implementer otherwise have to guess?
- Which interface or invariant could two teams interpret differently?
- What happens after partial success?
- Which deployment or data step is irreversible?
- What signal distinguishes healthy behavior from silent failure?
- Who makes the rollback or escalation decision?
- Which example can be verified automatically?
- What becomes stale first, and who must update it?
