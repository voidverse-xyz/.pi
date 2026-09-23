---
name: fullstack-blueprint
description: Scaffold a new application or deliberately migrate one toward a stack-neutral, layered full-stack architecture with explicit result envelopes and expected errors returned as values. Use only when the user explicitly chooses this blueprint; do not impose it on an existing repository, routine endpoint work, or frontend-backend integration that already has established conventions.
---

# Fullstack Blueprint

Use this opt-in blueprint to establish a coherent application architecture across
client, server, persistence, background work, and operations without requiring a
particular language, framework, database, package manager, shell, container
runtime, or deployment model.

Its defining application contract is:

- operations return `{ success, output, data }`,
- expected failures are values, not exceptions,
- unexpected faults are handled at boundaries,
- transport semantics such as HTTP status remain meaningful,
- authorization and tenant scope are explicit,
- features are built and migrated as vertical slices.

Preserve an existing application's established contracts unless the user has
explicitly chosen to migrate them.

## 1. Establish capabilities and constraints

Before choosing files, packages, or processes, inspect the target environment:

- application shape: monolith, modular monolith, services, serverless functions,
  workers, desktop/mobile client, frontend-only, or a combination,
- languages, frameworks, persistence technologies, and repository layout,
- dependency and build tooling,
- runtime and deployment targets,
- authentication, authorization, tenancy, and trust boundaries,
- synchronous and asynchronous interfaces,
- test, lint, type-check, migration, and observability capabilities,
- host operating systems and supported developer workflows.

For an existing repository, read project instructions and trace one representative
feature from entry point to persistence and back before proposing a structure. Do
not replace working local patterns merely because this blueprint uses different
names.

For a new project, make consequential choices explicit. Do not silently assume a
browser frontend, HTTP API, relational or document database, server process,
Docker, Node.js, or Unix shell.

## 2. Choose the application boundaries

Adapt these logical layers to the workload; they do not require one directory per
layer:

1. **Delivery/adapters** — HTTP, RPC, events, commands, jobs, or UI events.
2. **Application** — use cases, orchestration, authorization decisions, and result
   values.
3. **Domain** — business rules, entities/value types, and invariants when the
   domain warrants them.
4. **Infrastructure** — persistence, messaging, external services, filesystem,
   clocks, and platform APIs.
5. **Presentation/client** — rendering, user interaction, local state, and remote
   service adapters.

Dependencies should point toward stable application/domain contracts. Framework
objects, raw requests, database connections, and credentials should not flow into
business operations. Do not add repositories, domain objects, dependency
injection, or other abstractions unless they isolate a real boundary or enable a
needed test/substitution.

Name modules according to repository and language conventions. A small application
may colocate layers in a feature directory; a large system may separate packages
or services. Preserve the boundary, not a ceremonial folder tree.

## 3. Preserve the result envelope

Define one shared result constructor or equivalent type in each independently
built runtime:

```text
getResult(success, output, data = null)
    => { success, output, data }
```

The base contract is:

- `success`: boolean outcome of the requested application operation,
- `output`: safe user-facing or caller-facing message,
- `data`: successful payload, otherwise `null` unless an explicitly documented
  operation requires safe failure data.

Use the exact field names consistently across application operations and clients.
When separate projects cannot share a generated contract package, maintain
contract tests or fixtures that verify identical serialization.

### Expected errors are values

Return `success: false` for anticipated outcomes the caller can handle:

- invalid input or failed business rules,
- unauthenticated or unauthorized operation,
- inaccessible or missing resource,
- conflict, stale version, quota, or rate limit,
- dependency unavailability when it is an expected recoverable outcome.

Do not throw merely to take an ordinary failure path. Callers inspect `success`
and deliberately select UI, retry, fallback, or propagation behavior.

```text
function updateResource(actor, scopeId, input):
    if not canUpdate(actor, scopeId):
        return getResult(false, forbiddenMessage)

    validation = validate(input)
    if not validation.success:
        return getResult(false, validation.output)

    resource = store.updateWhereOwned(scopeId, actor.id, input)
    if resource is absent:
        return getResult(false, notFoundMessage)

    return getResult(true, successMessage, resource)
```

### Unexpected errors remain exceptions

Programming defects, broken invariants, corrupt state, and unexpected
infrastructure faults may raise/throw. Catch them at the nearest boundary that can
add useful context and decide recovery—typically a transport, job runner, or top-
level process handler. Log diagnostic details privately and return a safe failure
envelope when a caller needs a response.

Do not expose stack traces, queries, credentials, internal hostnames, or raw
provider errors through `output`. Do not catch and silently convert an exception
inside every function; that obscures faults and makes transactions or retries
unsafe.

### Keep transport semantics

The envelope does not replace protocol behavior. An HTTP adapter, for example,
should map results to appropriate status codes while returning the envelope body.
RPC, events, queues, and commands should use their own acknowledgement, retry, and
dead-letter semantics. Document the mapping once and test it.

A client service normalizes transport failures into the same application shape:

```text
async function callOperation(request):
    try:
        response = await transport.send(request)
        if response has a valid result envelope:
            return response.result
        return getResult(false, safeTransportMessage)
    catch expected network failure:
        return getResult(false, safeNetworkMessage)
```

Cancellation should remain cancellation when the platform distinguishes it; do
not misreport user cancellation or shutdown as a business failure.

## 4. Authentication, authorization, and scope

Authenticate at the delivery boundary and build an actor context containing only
necessary identity, roles/capabilities, locale, and tenant/scope information.
Pass that context to application operations—never pass raw credentials through
business logic.

Authorize each operation explicitly. For scoped resources, include the scope and
ownership constraints in the persistence query when possible:

```text
find resource where
    id = requestedId
    and scopeId = actor.scopeId
    and ownerId = actor.id
```

This prevents confused-deputy mistakes and avoids revealing whether inaccessible
records exist. Decide whether tenants share storage, schemas, databases, or
services based on compliance, isolation, operational cost, and scale—not a
framework default.

Enforce CSRF protections for state-changing cookie-authenticated browser requests,
use explicit cross-origin policies, and centralize bearer/session handling. Never
place long-lived credentials in URLs or ordinary request bodies.

## 5. Input, validation, and contracts

Keep boundary normalization distinct from business validation:

- **Parse/normalize/sanitize** converts an untrusted representation into safe
  primitives or rejects an invalid shape.
- **Validate** evaluates business rules and returns an expected failure result.
- **Persisted constraints** protect storage invariants and race-sensitive rules.

Do not validate the same rule in every layer. Generate or share schemas/types when
supported; otherwise use contract tests and representative fixtures across
independently built components.

Treat public APIs, events, stored data, configuration, and inter-process messages
as versioned contracts. Define compatibility, idempotency, ordering, concurrency,
limits, pagination/streaming, and error behavior as applicable.

## 6. Delivery adapters stay thin

A delivery handler should normally:

1. authenticate and establish request/job context,
2. enforce protocol protections and limits,
3. parse and normalize input,
4. call one application operation,
5. map the result envelope to the transport,
6. emit logs, metrics, and traces without exposing secrets.

Keep business decisions out of routing, controllers, UI event handlers, consumers,
or command parsers. Centralize unexpected-error handling and ensure a response or
acknowledgement is emitted at most once.

For uploads, downloads, and large payloads, define size limits, temporary-storage
ownership, cleanup on every outcome, content validation, and streaming/backpressure
behavior.

## 7. Persistence and external services

Expose only operations needed by the application rather than leaking a global
connection or provider client. Keep tenant/scope constraints visible. Make
transaction boundaries, consistency guarantees, retries, idempotency, timeouts,
and cleanup explicit.

Prefer explicit behavior over hidden persistence hooks when hooks make ordering,
failure, or testing difficult. Use framework-native capabilities when they remain
visible and locally conventional; the blueprint does not prohibit them.

For schema or data changes, define forward compatibility, backfill, verification,
rollback or roll-forward recovery, and legacy cleanup. Separate reversible deploy
steps from irreversible data changes.

External service adapters should translate provider-specific responses into
application-level results or typed infrastructure failures. Apply timeouts and
bounded retries only where the operation is safe to retry.

## 8. Client and presentation architecture

Keep remote calls behind a client/service adapter so authentication, transport
configuration, envelope validation, and failure normalization have one owner.
Navigation paths and API/operation identifiers are different contracts; do not
mix them merely because both are strings.

UI state must distinguish states the product needs. The envelope defines operation
outcomes but does not require one state library or forbid explicit loading/error
state. A simple screen may infer loading from absent data; a workflow that must
show retries, stale data, partial failure, or optimistic updates should model those
states explicitly.

Keep state ownership close to the narrowest common consumer. Introduce shared
stores, contexts/providers, query caches, or event buses only when their lifecycle
and invalidation behavior are justified.

Never treat `data` as successful without first checking `success`:

```text
function dataOrDefault(result, fallback):
    if result.success and result.data is not null:
        return result.data
    return fallback
```

## 9. Asynchronous work and notifications

Jobs and event consumers use the same application operations where practical but
retain broker/runtime delivery semantics. Define idempotency keys, retry limits,
backoff, poison-message handling, cancellation/shutdown, ordering, and
reconciliation.

When notification channels are fallbacks rather than broadcasts, try them in an
explicit order and stop after the first confirmed success. When every channel must
receive the message, model fan-out separately. Do not blur these semantics.

Real-time delivery must authenticate subscriptions, authorize each topic/resource,
handle reconnect and deduplication, and provide a fallback or resynchronization
path when delivery is not guaranteed.

## 10. Configuration, observability, and operations

Load configuration through one typed/validated boundary when the platform permits.
Fail startup for missing required configuration before accepting work. Keep
secrets out of source, logs, client bundles, build arguments, and generated
artifacts.

Instrument boundaries and important use cases with structured logs, metrics, and
traces appropriate to the runtime. Include correlation/request/job identifiers and
safe scope identifiers; exclude credentials and sensitive payloads. Define health,
readiness, alerting, and graceful shutdown behavior.

Do not hard-code one process model. A web server, function, worker, desktop app,
or static client has different initialization and shutdown requirements. Start
accepting work only after required dependencies are ready.

## 11. Build one vertical slice

After the foundational contracts exist, implement one representative feature end
to end:

1. contract/schema and result cases,
2. persistence or external adapter,
3. application operation with actor and scope,
4. delivery adapter,
5. client/service adapter when applicable,
6. presentation or consuming workflow,
7. tests and observability.

Verify the literal paths, operation names, schemas, and envelope behavior across
boundaries. Use the completed slice as a local example, then adapt rather than
blindly copy it.

For migrations, move feature by feature so the application remains runnable.
Create compatibility adapters when old and new contracts must coexist. Do not
migrate layer by layer if that leaves every feature half-converted.

## 12. Verification strategy

Choose tests based on risks and available tooling:

- unit tests for business rules and expected result values,
- integration tests for persistence, transactions, and external adapters,
- contract tests for envelope shape, statuses, schemas, and compatibility,
- authorization tests across roles and tenant boundaries,
- end-to-end tests for critical vertical slices,
- migration tests for forward/backward compatibility and data verification,
- operational tests for startup, shutdown, retry, recovery, and observability.

At minimum, test both success and important `success: false` cases, plus unexpected
exception mapping at each delivery boundary. Verify that failure `output` is safe
and that failure data does not leak inaccessible resources.

## 13. Operating principles

- **Opt in:** use this blueprint only after explicit selection.
- **Explore first:** existing project instructions and patterns are authoritative.
- **Keep decisions visible:** explain deliberate deviations and trade-offs.
- **Match complexity:** add an abstraction only for a demonstrated boundary.
- **Preserve local work:** make reversible edits and confirm destructive actions.
- **Respect dependencies:** parallelize independent research, not dependent writes.
- **Keep vertical coherence:** change contracts and all affected consumers together.
- **Verify claims:** run the repository's supported checks and report limitations.

## Completion report

Report:

- detected workload and stack,
- selected boundaries and explicit deviations,
- result-envelope and error-as-value behavior implemented,
- authentication, tenancy, compatibility, and failure decisions,
- tests and operational checks performed,
- unresolved risks or unverified runtime assumptions.
