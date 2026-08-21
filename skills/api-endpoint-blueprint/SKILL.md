---
name: api-endpoint-blueprint
description: Add, change, or debug an HTTP API endpoint by tracing the repository's route, middleware, handler, domain, persistence, and test layers. Use for endpoint work in layered backend applications; adapt to local architecture instead of imposing a fixed framework pattern.
---

# API endpoint blueprint

Implement an endpoint as one contract flowing through the repository's existing layers. Reuse the nearest comparable endpoint before introducing new abstractions.

## Discover the existing path

Before editing:

1. Read the applicable repository instructions.
2. Find a sibling endpoint with similar authentication, input shape, and persistence behavior.
3. Trace it from route registration through middleware, handler/controller, domain or service logic, persistence, serialization, and tests.
4. Identify the project's response envelope, error model, validation library, logging conventions, and localization boundary.

Do not assume every project uses separate controllers, services, repositories, or role-specific modules. Preserve the layers that actually exist.

## Define the contract

Confirm from code or requirements:

- HTTP method and mounted path.
- Authentication and authorization rules.
- Path, query, header, and body inputs.
- Validation, normalization, and defaulting behavior.
- Success status and response shape.
- Error statuses and public error representation.
- Idempotency, pagination, concurrency, or rate-limit behavior where relevant.
- Side effects such as notifications, jobs, audit events, or cache invalidation.

Keep transport validation separate from business invariants when the project already makes that distinction.

## Implement through the existing layers

### Route and middleware

Register the route in the established router. Preserve meaningful middleware order—for example request context, authentication, authorization, rate limiting, parsing, and validation. Avoid duplicating checks already enforced by shared middleware.

### Handler or controller

Keep transport concerns at the boundary:

- Read validated inputs.
- Call one clear application/domain operation.
- Translate the result into the project's HTTP response contract.
- Pass failures through the established error mechanism.

Do not place persistence queries in a thin handler when sibling endpoints delegate them.

### Domain, service, and persistence

Enforce business rules at the layer used by comparable operations. Scope reads and writes by the authenticated actor or tenant in the query itself when required. Preserve transaction, model, repository, and connection conventions.

Emit follow-up work only after the mutation is known to have succeeded. If a side effect must be atomic with persistence, use the project's transaction or outbox pattern rather than an uncoordinated call.

### Errors, localization, and observability

Return only intentional public errors; do not expose internal exceptions or sensitive data. Use the existing localization system for user-facing messages. Match logging and audit conventions without logging credentials, tokens, or unnecessary request bodies.

## Verify end to end

Add or update the smallest authoritative tests that cover:

1. Successful request and exact response contract.
2. Missing or invalid input.
3. Unauthenticated and unauthorized access.
4. Not-found, conflict, or invariant failures relevant to the operation.
5. Persistence scoping and side effects.
6. Route mounting, so the tested path is the path the application serves.

Run the repository's formatter, focused tests, and relevant type or lint checks. Report any unverified integration boundary explicitly.
