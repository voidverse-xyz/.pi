---
name: live-notifications
description: Design, add, or debug real-time data updates and user alerts across backend delivery, shared event contracts, authorization, client subscriptions, reconnection, deduplication, and fallback channels. Use for WebSocket, SSE, broker-backed, push, or similar notification flows.
---

# Live updates and notifications

Trace the complete delivery path before changing one end of it. A typical path is mutation → event creation → broker or transport → authenticated subscription → client state update or user alert.

## Map the existing system

Identify:

1. Where event names and payload schemas are defined.
2. Which operation emits each event and whether it occurs before or after persistence commits.
3. How recipients, tenants, rooms, topics, or channels are selected.
4. Which transport is used, such as WebSocket, Socket.IO, SSE, push, or a message broker.
5. How clients connect, authenticate, subscribe, reconnect, and disconnect.
6. How consumers deduplicate events and update or invalidate state.
7. Whether offline, mobile, email, or SMS fallback exists.

Reuse the project's established transport and event registry. Do not introduce a second connection singleton or parallel event taxonomy without a clear migration plan.

## Define a stable event contract

An event should have enough information for routing and safe processing, commonly:

- A stable event name or type.
- A unique event identifier for deduplication.
- Resource or aggregate identity.
- Tenant or scope identity when applicable.
- A version when payload evolution requires it.
- The minimal payload consumers need.

Avoid placing secrets or unnecessary personal data in events. Prefer identifiers plus an authorized refetch when broadcasting full records would create privacy or staleness risks.

Keep producer and consumer constants or generated schemas synchronized through one authoritative source when the project supports it.

## Emit safely

- Emit only after the underlying state change is confirmed.
- If delivery must survive process failure or be atomic with the write, use a transaction-aware outbox or the project's equivalent.
- Define whether delivery is at-most-once, at-least-once, or best effort; make consumers idempotent when duplicates are possible.
- Separate data-change signals from human-facing alerts when their payloads, urgency, or fallback behavior differ.
- Bound retries and surface permanent delivery failures to the system that owns them.

## Authorize subscriptions and delivery

Authenticate connections using the project's supported mechanism. Authorize every room, topic, resource, or tenant subscription; possession of an identifier alone must not grant access.

Re-check authorization when account membership or permissions can change during a long-lived connection. Remove subscriptions and listeners during disconnect or scope changes.

## Handle client lifecycle

- Keep one connection owner per intended application scope.
- Register and remove handlers symmetrically.
- Reconnect with bounded backoff and restore authorized subscriptions.
- Deduplicate by event ID when retries, multiple transports, or reconnect replay can duplicate delivery.
- Ignore events outside the active tenant or resource scope.
- Update a local cache directly only when the payload is complete and ordered; otherwise invalidate or refetch the affected data.
- Show offline or degraded state when users would otherwise assume updates are live.

## Verify end to end

Test representative cases:

1. Authorized delivery to the intended recipient.
2. No delivery to unauthorized users or unrelated tenants.
3. Emission only after a successful mutation.
4. Duplicate and out-of-order event handling where applicable.
5. Disconnect, reconnect, resubscription, and listener cleanup.
6. Offline or fallback delivery behavior.
7. Producer/consumer schema compatibility.

Use integration tests for room/topic routing and lifecycle behavior when unit tests cannot represent the transport accurately.
