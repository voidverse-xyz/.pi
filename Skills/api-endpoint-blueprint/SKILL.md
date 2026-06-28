---
name: api-endpoint-blueprint
description: How to add or modify a backend API endpoint in this Express app, following its route → controller → role → base layering, auth/sanitize/validate flow, the getResult envelope, and i18n. Use whenever creating, editing, or debugging anything under backend/routes, backend/controllers, or backend/services for an HTTP endpoint.
---

# Backend endpoint architecture

The backend is a strict 4-layer pipeline. A request flows:

```
routes/paths/<entity>.js          (mounts role sub-routers)
  -> routes/paths/<role>/<entity>.js   (express handler: limit, sanitize, call, send, log)
    -> controllers/<entity>.js         (re-exports role namespaces)
      -> controllers/<role>/<entity>.js  (auth check, extract user, delegate to base)
        -> controllers/base/<entity>.js    (DB logic, validation, returns getResult)
```

Roles are `admin` and `doctor` (entity controllers re-export by role). Keep every layer's
responsibility separate — don't put DB logic in a route, or auth in base.

> **Follow this layering when possible — it's the default, not an absolute law.** If you think a
> different structure is genuinely better for a case, don't silently diverge and don't blindly
> conform: explain to the user *why* the alternative is clearly better, with concrete reasons,
> and confirm before doing it. When there's no clear win, follow the convention.

Mount points are wired in `backend/routes/routes.js` and aggregated by `backend/routes/paths/index.js`,
`backend/controllers/index.js`, `backend/services/index.js`, `backend/database/schemas/index.js`.

## Layer 1 — Route handler (`routes/paths/<role>/<entity>.js`)

Every endpoint follows this exact shape. POST is the default; bodies are JSON.

```js
router.post("/create-exercise", async (req, res) => {
    await limit(req, res);                          // rate limit, always first

    let json = req.body ?? {};
    let auth = sanitizeService.text(json.auth);     // sanitize EVERY field
    let name = sanitizeService.text(json.name);
    let properties = sanitizeService.array(json.properties);

    let result = await exerciseController.doctor.createExercise(auth, name, properties);

    res.send(result);                               // send the getResult envelope
    logResult(req, result);                         // log last
});
```

- Sanitize each field with `sanitizeService` (`text`, `number`, `array`, `object`, `email`).
  Sanitize is coercion/cleanup only — real validation happens in base.
- Sub-router is exported as `export { router as doctorRouter };` and mounted in the entity's
  `routes/paths/<entity>.js` via `router.use("/doctor", doctorRouter)`.
- Imports: `exerciseController` from `controllers/index.js`, `sanitizeService` from
  `services/index.js`, plus `logResult` from `services/logger.js` and `limit` from `services/limit.js`.

## Layer 2 — Entity controller (`controllers/<entity>.js`)

Just re-exports role namespaces:

```js
export * as admin from "./admin/exercise.js";
export * as doctor from "./doctor/exercise.js";
```

## Layer 3 — Role controller (`controllers/<role>/<entity>.js`)

Authenticate, bail early on failure, extract the user, delegate to base:

```js
export async function createExercise(auth, name, properties) {
    let verified = authService.isDoctor(auth);      // isAdmin / isDoctor / isUser / isCaregiver
    if (!verified.success) {
        return verified;                            // propagate the failure envelope
    }

    let doctor = verified.data;

    return await base.createExercise(doctor._id, doctor.langId, name, properties);
}
```

- `auth*Service` checks return a `getResult` whose `.data` is the user. Pass `langId` down so
  base can localize messages. Admin endpoints typically pass `null` ids for global/default rows.

## Layer 4 — Base controller (`controllers/base/<entity>.js`)

All DB access and validation lives here. Validate, hit Mongo, return `getResult` with a
translated message.

```js
export async function createExercise(doctorId, langId, name, properties) {
    let validation = {};
    if (!validationService.text(name, validation, langId, "invalid_exercise_name")) {
        return getResult(false, validation.output);
    }

    let exerciseModel = getModelMain(exerciseSchema);
    let exerciseDoc = new exerciseModel();
    exerciseDoc.name = name;
    exerciseDoc.doctorId = doctorId;
    await exerciseDoc.save();

    return getResult(true, t(langId, "doctor_create_exercise_success"), exerciseDoc._id.toString());
}
```

- Validate with `validationService` (`text`, `email`, `password`, `url`, `clinic`, ...). Pass a
  `validation` object + `langId` + a translation key; on failure return `getResult(false, validation.output)`.
- DB access:
  - Main DB: `getModelMain(<schema>)`.
  - Per-clinic DB (multi-tenant): `getModel(clinicId, <schema>)`; iterate `getClinicIds()` when
    you must touch all clinics. Schemas split into `schemas/main/*` and `schemas/clinic/*`.
  - Use `.lean().exec()` for reads, `findOne(...).exec()` + `.save()` for mutations.
- Side effects: live notifications via `notifyLiveEvent` / `notifyAlertEvent` (from
  `backend/notify/notify.js`) — see the `live-notifications` skill; file storage via
  `storageService` with `envService.getBucketMain()`.

## Translations

Never hardcode user-facing strings. Use `t(langId, "key", ...args)` in base, `tu(user, "key")`
when you have a user object. Key convention: `<role>_<action>_<entity>_success`
(e.g. `doctor_create_exercise_success`), `invalid_<thing>`, `error_<thing>`. Add the key to
**every** file in `backend/languages/` (`en.json`, `fr.json`, `es.json`, `jp.json`, `ar.json`).
See the `i18n` skill for details.

## Checklist to add an endpoint

1. Base function in `controllers/base/<entity>.js` (validate → DB → `getResult` + `t(...)`).
2. Role function in `controllers/<role>/<entity>.js` (auth check → delegate to base).
3. Route handler in `routes/paths/<role>/<entity>.js` (limit → sanitize → call → send → log).
4. New translation keys in all `backend/languages/*.json`.
5. If a new entity: create `controllers/<entity>.js`, the role sub-router export, mount in
   `routes/paths/<entity>.js`, register in `routes/routes.js`, and add to the relevant `index.js`
   aggregators (alphabetically).
6. Mirror the call on the frontend — see the `frontend-backend-call` skill.
