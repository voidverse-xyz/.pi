---
name: live-notifications
description: How real-time / live data updates and push alerts work in this app — Socket.IO over a Redis adapter on the backend (notifyLiveEvent / notifyAlertEvent + SMS fallback), and the frontend Socket singleton + useNotify hook + NotifyContext that fan out to type-based refetch. Use whenever adding, editing, or debugging websocket/live updates, push/SMS notifications, or making a UI auto-refresh when data changes.
---

# Live notifications & real-time updates

This app pushes server-side changes to connected clients over **Socket.IO** (multiplexed across
instances by a **Redis adapter**), with a **Twilio SMS fallback** for alerts. There are two event
kinds:

- **Live events** (`notifyLiveEvent`) — "data changed, refetch": carry only `{ id, type, clinicId }`,
  the client reacts by re-running queries. Delivered to a user's **live room** (`user._id`).
- **Alert events** (`notifyAlertEvent`) — "tell the user something": carry `{ id, type, data }`
  with title/message, shown as a toast and/or sent over SMS if the socket isn't connected.
  Delivered to a user's **alert room** (`notifications-<user._id>`).

> **Follow this pattern when possible — it's the default, not an absolute law.** If a different
> approach is genuinely better for a case, don't silently diverge and don't blindly conform:
> explain to the user *why* the alternative is clearly better, with concrete reasons, and confirm
> before doing it. When there's no clear win, follow the convention.

## Event types (shared contract)

The `type` strings are constants defined **identically** in `backend/services/utils.js` and
`frontend/src/lib/utils.js` — `NOTIFY_LIVE_*` (e.g. `NOTIFY_LIVE_ALL`, `NOTIFY_LIVE_USERS`,
`NOTIFY_LIVE_EXERCISE`, `NOTIFY_LIVE_SHARED`, `NOTIFY_LIVE_FEEDBACKS`) and `NOTIFY_ALERT_*`
(e.g. `NOTIFY_ALERT_MESSAGE`, `NOTIFY_ALERT_FEEDBACK`, `NOTIFY_ALERT_INVITATION`). The wire
channel is `NOTIFY_CHANNEL = "notifications"`. **A new type must be added to both files with the
same value.**

## Backend

### Emitting from a controller

Emit from the **base or role controller** after a successful mutation, just before returning
`getResult`. Pass the user ids that should be notified.

```js
import { notifyLiveEvent, notifyAlertEvent } from "../notify/notify.js";
import { NOTIFY_LIVE_USERS, NOTIFY_ALERT_MESSAGE } from "../services/utils.js";

// live: "users changed, refetch" — fan out to one or many ids
await notifyLiveEvent(NOTIFY_LIVE_USERS, [user._id]);

// per-clinic live event (multi-tenant) — pass clinicId so clients on other clinics ignore it
await notifyLiveEvent(NOTIFY_LIVE_SHARED, [feedbackDoc.patientId], clinicId);

// alert: targeted message with payload (title/message used by toast + SMS)
await notifyAlertEvent(NOTIFY_ALERT_MESSAGE, [receiverId], {
    title: t(langId, "..."),
    message: t(langId, "..."),
});
```

Rules:
- `users` is always an **array of ids**; nulls are filtered out, so passing `[a, b, c]` is fine.
- Use `notifyLiveEvent` for "data changed" and `notifyAlertEvent` for "notify a person".
- Pass `clinicId` to `notifyLiveEvent` for clinic-scoped changes so other clinics' clients skip it.

### How delivery works (`backend/notify/`)

- `notify/notify.js` orchestrates: `notifyLiveEvent` / `notifyAlertEvent` build the event, then
  `notify()` tries each registered **stream** in order per user and **stops at the first stream
  that returns `true`** (delivered). Streams are set up in `initialize()`.
- `notify/socket/socket.js` — the primary stream. Sets up the Socket.IO `Server` over HTTPS with
  the `@socket.io/redis-adapter` (pub/sub clients), authenticates each connection via
  `authService.isUser(handshake.query.auth)`, and on connect joins the socket to its **live room**
  (`user._id`) and **alert room** (`convertToAlertListenerId`). Returns an `emitter(room, data)`
  that emits on `NOTIFY_CHANNEL` and returns `false` if no sockets are in the room (so the next
  stream gets a chance).
- `notify/mobile/mobile.js` — the **fallback** stream. If the socket emitter returned `false`
  (user offline), this sends the alert's `title`/`message` via Twilio SMS to the user's
  `phoneNumber`. Live events have no `data`, so they effectively no-op here.
- Clients can subscribe to extra rooms at runtime: the socket listens on `user._id` and joins the
  room id the client emits (see `convertToLiveListenerId`), used for shared/cross-user live data.

## Frontend

### Transport singleton (`frontend/src/services/socket.js`)

`Socket` is a module singleton (IIFE) with `connect(auth, user)`, `listen(id)` (emit to join an
extra room), `connection()`, and `disconnect()`. It reconnects when `auth`/`user` change and
connects to `process.env.URL_SOCKET?auth=<auth>`. Don't create sockets elsewhere — go through it.

### `useNotify` hook (`frontend/src/hooks/notify.js`)

Owns the connection lifecycle and exposes `{ initialized, connected, notification }`:

- On `auth`/`user` change it connects (or disconnects), and registers handlers on `NOTIFY_CHANNEL`
  plus `connect`/`disconnect`/`connect_error`.
- **De-dupes** events by `notification.id` (keeps a capped in-memory list) so the same event isn't
  processed twice.
- On `users` change, calls `Socket.listen(user._id)` for each, joining their live rooms.
- The latest event is published as the `notification` state value.

### `NotifyContext` (`frontend/src/context/notify.js`)

`NotifyProvider` wraps the tree, calls `useNotify`, and renders an **offline banner**
(`t(langId, "offline_live")`) when `!connected`. Exposes `{ initialized, connected, notification }`.

### Reacting to events — two consumer patterns

**1. Refetch on any change** (simple components): depend on `notification` in a `useEffect` so the
effect re-runs whenever a new event arrives.

```js
const { notification } = useContext(NotifyContext);

const onUseEffect = useEffectEvent(async () => {
    // recompute / refetch
});

useEffect(() => {
    onUseEffect();
}, [notification, patients, doctors]);
```

**2. Type dispatch** (role layouts, e.g. `app/clinic/[clinicId]/<role>/layout.js`): `switch` on
`notification.type` to run the right refresh callbacks, and **bail early when the event's
`clinicId` doesn't match the current clinic**:

```js
if (notification.clinicId && notification.clinicId !== clinicId) {
    return;
}

switch (notification.type) {
    case NOTIFY_LIVE_USERS:
        return async () => { await caregiverCallbacks.updateAssignments(); };
    case NOTIFY_ALERT_MESSAGE:
        return getNotificationMessageCallback; // toast + navigation
    // ...
}
```

Live cases call the role data-context `update*` callbacks (see the `frontend-backend-call` skill
for hooks/context). Alert cases show a toast and may route the user.

## Checklist to add a live update or alert

1. Pick/define the `type` constant in **both** `backend/services/utils.js` and
   `frontend/src/lib/utils.js` (same value).
2. Backend: after the successful mutation in the controller, call `notifyLiveEvent(type, [ids],
   clinicId?)` (data changed) or `notifyAlertEvent(type, [ids], { title, message })` (notify a
   person). Use `t(...)`/`tu(...)` for the alert text — see the `i18n` skill.
3. Frontend: handle the new `type` — add a `case` in the relevant role `layout.js` dispatch, or
   make the consuming component depend on `notification`. Wire it to the matching data-context
   `update*` callback (live) or a toast/route (alert).
4. For alerts that should reach offline users, ensure the recipient has a `phoneNumber` (the
   Twilio fallback uses it).
