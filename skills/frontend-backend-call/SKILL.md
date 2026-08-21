---
name: frontend-backend-call
description: Connect a frontend feature to a backend endpoint while preserving the project's API client, response contract, state ownership, caching, and error handling. Use when adding or changing client services, React hooks, query integrations, contexts, or consuming components.
---

# Frontend-to-backend integration

Treat the backend contract, client abstraction, and UI state lifecycle as one flow. Reuse the nearest working feature before adding a new service or state layer.

## Trace the existing pattern

Inspect:

1. The backend route's method, mounted path, inputs, authentication, and response shape.
2. The shared frontend HTTP client and its base URL, headers, serialization, cancellation, and error normalization.
3. A comparable service function.
4. The component, hook, query library, store, or context that owns similar state.
5. Tests or mocks that define the client contract.

Do not assume the frontend mirrors backend directories or requires a hook/context pair. Follow the architecture already in use.

## Implement the client boundary

Keep endpoint details in the established service or generated-client layer rather than scattering URLs through components.

A service function should make its inputs and result contract clear:

```ts
export async function updateResource(input: UpdateResourceInput, options?: RequestOptions) {
  return client.patch(`/resources/${input.id}`, input.changes, options);
}
```

Adapt the example to local conventions. In particular:

- Build paths from the actual mounted route.
- Put credentials or session headers in the shared client, not individual calls, unless the project requires otherwise.
- Preserve the project's success/error representation.
- Support cancellation or request identity when stale responses are possible.
- Avoid leaking transport-specific details beyond the service boundary.

## Choose the smallest state owner

Use the narrowest existing mechanism that fits:

- Component state for local, short-lived interaction.
- A custom hook for reusable behavior or lifecycle logic.
- A query/cache library for server state when the project already uses one.
- Context or a store only when state must be shared across a meaningful subtree or application boundary.

Do not create a context, provider, reducer, or global store solely because an API call was added.

## Handle lifecycle and races

- Represent loading, success, empty, and failure states intentionally.
- Prevent stale requests from overwriting newer state.
- Clean up subscriptions and cancel requests when supported.
- Keep effect dependencies accurate; do not suppress warnings to hide unstable design.
- Use optimistic updates only when rollback and conflict behavior are defined.
- Invalidate or update the correct cache entries after mutations.

Translate technical errors into the project's user-facing error system without discarding diagnostic context needed by logs or tests.

## Verify the integration

Test the layers that carry real risk:

1. Service method, path, payload, and headers.
2. Success and normalized failure handling.
3. Loading and stale-response behavior.
4. Cache invalidation or shared-state propagation.
5. The consuming UI's important success and error states.

Run focused frontend tests and type/lint checks. When practical, verify the call against the actual backend route rather than relying only on a mock with a separately invented contract.
