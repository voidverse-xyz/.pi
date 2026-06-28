---
name: fullstack-blueprint
description: Opinionated architecture & style template for building (or refactoring toward) a full-stack Express+Mongoose API and Next.js/React App Router frontend — response-envelope contract, named-export barrels, role/resource mirroring across stacks, context/hook 1:1 pairing. Use when scaffolding a new full-stack app in this style, adding a resource end-to-end, or aligning an existing app to these conventions.
---

# Fullstack Blueprint: Express+Mongoose API + Next.js/React frontend

A **portable build template** for scaffolding a new full-stack project in a clean,
consistent style, or refactoring an existing app toward it. Every pattern below is
stated completely enough to reproduce without seeing any original codebase.

Domain specifics use placeholders: `<Resource>` (a noun — "Order," "Document"),
`<Role>` (a type of caller — "admin," "owner," "member"), `<Scope>` (a tenant
boundary — "org," "workspace"). Code blocks are real shapes, genericized. Where a
pattern hides a rough edge that deserves a deliberate decision rather than blind
copying, it's flagged **⚠**.

## How to use this

**This is a strong default, not a straitjacket.** Follow these patterns whenever they
fit. But if you see a solution that is genuinely, unambiguously better for the case at
hand, **don't silently follow the blueprint and don't silently override it either** —
pause and tell the user: what the blueprint says, what you'd do instead, and the concrete
reasons it's better (not a stylistic preference — a real correctness, security,
maintainability, or performance win you're confident is ~100% the right call). Let them
decide. When it's a close call or just taste, follow the blueprint; only raise the
deviation when you're confident the alternative clearly wins.

1. Decide your roles/tenancy model first (§5) — it determines whether you need the
   role-split pattern in §2.3 and §3.3 at all.
2. Stand up the contract before any resource exists: the response envelope (§4.1), the
   barrel convention (§4.2), the shared-constants file pair (§2.5.1/§3.6).
3. Build one full vertical slice for one resource — schema → controller → route →
   frontend service → hook/context → page — using §2 and §3 as the literal templates.
   That slice becomes the copy-paste template for every later resource.
4. Apply §1 throughout: it governs *how* you work, not just what the code looks like.

---

## 1. Operating principles

These apply regardless of which layer you're touching.

**Follow the blueprint by default; flag a clearly-better path, don't take it silently.**
These patterns win unless you have a specific reason they don't. When you do — a real
correctness/security/maintainability/performance advantage you're confident in, not a
preference — surface it to the user before deviating: state the blueprint's approach, your
alternative, and why it's clearly better, then let them choose. Never strictly enforce a
pattern you can see is wrong for the case, and never quietly swap in your own approach
without saying so. Close calls and taste: follow the blueprint.

**Explore before writing.** Before adding a resource, read one existing resource's full
file set end to end (schema, controller, route, frontend service) and copy its shape —
don't improvise a new one from memory of "what Express apps usually look like." For
changes under ~2 files, skip the ceremony and just make the change.

**Verify, don't assert.** This template has no automated test suite by default (a real
gap, see §4.5) — there's no safety net catching a wrong assumption after the fact. After
writing a controller, trace the request by hand: auth check first, validation chain in
the right order, query scoped by the actor's own id, response through the one envelope
shape. After wiring a backend route, grep the frontend for the literal path string you
used — there's no compile-time link between the two stacks, so a typo is silent until
checked.

**Match the existing level of complexity — don't add to it.** This style deliberately
has no repository/ORM-abstraction layer, no generic data-fetching library, no test
framework, no schema-hook magic. That's not an oversight to fix by default; it's the
chosen tradeoff. Don't add error handling, validation, or abstractions for cases that
can't happen — trust the layer that's supposed to own each check (sanitize at the route
boundary, validate in the controller, `required: true` in the schema — once, not three
times). Don't write comments explaining *what* code does; name things so it's
unnecessary. A bug fix doesn't need surrounding cleanup; three similar functions don't
need a premature shared abstraction extracted until a fourth reveals the real shape of it.

**Match the blast radius.** Take local, reversible actions freely (editing files,
running a dev server, reading the schema). Confirm before anything hard to reverse or
visible to others: deleting files/branches, force-push, amending pushed commits,
touching a `Containerfile` or any file that bakes secrets/env vars into a deployed
build, sending a real notification through the system you're building.

**Parallelize reads, never parallelize dependent writes.** Reading several existing
files to learn a pattern: do it in parallel, they're independent. Writing a new
resource's files: respect the real order — schema before controller (controller imports
it), controller before route (route imports it), backend route before frontend service
(the frontend's path string has to match something that already exists).

---

## 2. Backend (Express + Mongoose)

### 2.1 Layout

```
server.js                         entry point — sequences service init, then starts listening
routes/routes.js                  Express app, middleware, router mounting
routes/paths/<role>/<resource>.js routes for <role> acting on <resource>
controllers/base/<resource>.js    role-agnostic shared logic (no auth param — caller already authorized)
controllers/<role>/<resource>.js  business logic for <role> acting on <resource>
database/database.js              connection management, getModel()/getModelMain()
database/schemas/<scope>/<resource>.js   schema definitions, plain functions not models
services/<concern>.js             one cross-cutting concern per file (auth, validate, sanitize, ...)
notify/                           ordered multi-channel notification dispatch with fallback
languages/<locale>.json           flat i18n translation files
```

Every layer that touches a resource is barreled: `controllers/index.js`,
`routes/paths/index.js`, `database/schemas/index.js`, `services/index.js` each re-export
their directory's modules under a namespaced alias (`<x>Controller`, `<x>Service`). Named
exports only — never `export default` — so `export * as x from "./x.js"` barrels work
uniformly everywhere.

### 2.2 Boot sequence

`server.js` does nothing but sequence initialization, in dependency order, ending with
the HTTP listener — nothing should accept traffic before everything it might touch is
ready:

```js
async function main() {
    languageService.initialize();   // must succeed or abort
    loggerService.initialize();
    await redis.connect();
    await database.connect();       // open DB connection(s) — see §2.4
    await notify.initialize();
    await routes.start();           // LAST
}
main();
```

`routes/routes.js` wires Express: `cors()` → `helmet()` → `compression()` → body parsers
→ a request-logging middleware → one `app.use("/<resource>", router)` line per resource →
a single global error handler last. The error handler checks `error.rateLimit` (or any
similar flag a handler sets before throwing to short-circuit) so it doesn't double-send a
response.

### 2.3 Controllers — the core contract

**The role split.** A flat `controllers/<resource>.js` barrel re-exports per-role
submodules — this is *not* inheritance, it's "different callers get different functions":

```js
// controllers/<resource>.js
export * as <roleA> from "./<roleA>/<resource>.js";
export * as <roleB> from "./<roleB>/<resource>.js";
```

`controllers/<roleA>/<resource>.js` and `controllers/<roleB>/<resource>.js` typically
contain entirely different functions (what `<roleA>` can do to `<resource>` differs from
`<roleB>`). Genuinely shared logic goes in `controllers/base/<resource>.js`, with no
`auth` param — it's called only after the caller already authorized. **Only introduce
this split once a resource actually has more than one type of caller** — a single-role
resource is just `controllers/<resource>.js` with functions directly in it.

**The function contract** — every controller function follows this shape:

```js
export async function get<Resource>(auth, <scope>Id, <resource>Id) {
    // 1. Auth first, always. Bail by returning the failed envelope directly.
    let valid = authService.is<Role>(auth);
    if (!valid.success) return valid;
    let actor = valid.data;

    // 2. Validate. Chain with ||, first failing check's message wins.
    let validation = {};
    if (!validationService.text(<resource>Id, validation, actor.langId, "invalid_<resource>")) {
        return getResult(false, validation.output);
    }

    // 3. Query. Direct Mongoose. Scope by the actor's own id in the FILTER, not after fetching.
    let model = getModel(<scope>Id, <resource>Schema);
    let doc = await model.findOne({ _id: <resource>Id, ownerId: actor._id }).lean().exec();
    if (!doc) return getResult(false, tu(actor, "invalid_<resource>"));

    // 4. Respond. Always through getResult(); message translated via tu().
    return getResult(true, tu(actor, "<role>_get_<resource>_success"), doc);
}
```

Why each part matters: **(1)** there's no Express auth middleware — `auth` is an explicit
first argument to every controller, and the function is plain `(auth, ...args)`, never
`(req, res)`, so it's callable from a route, a socket handler, or a script without change.
**(2)** validators mutate a shared `{}` and only set `.output` if unset, so check order =
error-priority order. **(3)** scoping ownership inside the query filter (rather than
fetch-then-check) makes "not yours" and "doesn't exist" indistinguishable to the caller —
a deliberate information-hiding property. **(4)** no try/catch and no thrown custom errors
in controllers — failure is a returned value (`getResult(false, ...)`), not an exception;
unexpected exceptions are caught once, centrally, by the Express error handler.

`getResult` is one function, defined once, used everywhere on both stacks:
```js
export function getResult(bool, output, data = null) { return { success: bool, output, data }; }
```

### 2.4 Database

Schema files export plain functions, never a compiled model:

```js
export function getSchema() {
    return new Schema(
        { <scope>Id: { type: String, required: true, index: true }, /* ...fields */ },
        { collectionOptions: { changeStreamPreAndPostImages: { enabled: true } } },
    );
}
export function getName() { return "<resources>"; }       // literal collection name
export function santize(doc) { delete doc.password; }      // optional — strip sensitive fields
```

No Mongoose `methods`/`statics`/`virtuals`/hooks — every behavior that touches a document
is a plain exported function, called explicitly, visible at the call site. For a document
that "extends" another collection's record, add a `populate(doc)` function that does a
second query and merges fields in manually (`copyObject(doc, otherDoc)`) rather than using
Mongoose refs.

`database.js` exposes `getModel(scopeId, schema)` / `getModelMain(schema)` so controllers
never hold a connection reference directly. ⚠ **Tenancy decision**: a per-tenant model
opens one full Mongoose connection *per tenant* (hard data isolation — only adopt this if
you have a real compliance or data-residency requirement). Default instead to one
connection with a `scopeId` field on every document, included in every query filter —
simpler, one connection pool, one set of indexes.

### 2.5 Services — one file per concern, barreled

| file | responsibility |
|---|---|
| `auth.js` | issue/verify JWTs; `isRole(auth)` checks, each returning the standard envelope |
| `validate.js` | business-rule predicates → boolean + translated `validation.output` message |
| `sanitize.js` | raw input → safe primitive; never throws, never sets an error message |
| `utils.js` | `getResult()`, shared enums/constants (roles, epoch durations, notify-event names) |
| `env.js` | typed getters over `process.env`, no validation by default — see ⚠ below |
| `logger.js` | buffered request/error logging, periodic flush to durable storage |
| `limit.js` | rate limiting + spam detection, Redis-backed, keyed by actor id or IP |
| `language.js` | i18n: `t(langId, key, ...args)` / `tu(user, key, ...args)`, `{{n}}` placeholders |

Keep `validate` and `sanitize` separate even though they look similar: sanitize defends
against bad *shapes* so later code never crashes; validate enforces business rules and
produces the user-facing message. Don't let one do the other's job.

#### 2.5.1 Shared constants

`utils.js` holds the epoch-duration constants, role-number enum, and notify-event-name
enum used across the whole backend. **This same constant block must be duplicated,
byte-for-byte, in the frontend's `lib/utils.js`** (§3.6) — there's no shared package
between the two Node projects, so keeping role numbers and event names in sync across the
stacks is a manual discipline, not something the type system enforces. Update both files
in the same change whenever you touch one.

⚠ **Env vars**: by default, every `env.js` getter is an unchecked passthrough
(`process.env.X`) with no required-vs-optional enforcement and no startup assertion.
Decide deliberately whether that's acceptable for your project or whether you want
validation once, centrally, at boot — don't scatter validation across individual getters
either way.

### 2.6 Routes — thin wiring only

```js
router.post("/get-<resource>", async (req, res) => {
    await limit(req, res);                                  // rate-limit check first
    let json = req.body ?? {};
    let auth = sanitizeService.text(json.auth);
    let id = sanitizeService.text(json.<resource>Id);
    let result = await <resource>Controller.<role>.get<Resource>(auth, id);
    res.send(result);
    logResult(req, result);                                  // after the response is sent
});
```

Every leaf handler is this same five-line shape: rate-limit → sanitize each field
individually (never pass `req.body` straight through) → call exactly one controller
function → send the envelope → log. Route paths are inline kebab-case literals — no
shared constants module on the backend (the frontend has its own internal path-builder
service, kept separate — §3.4). File uploads route through a `multer`-based
`handleUpload(req, res, configureMulter, action)` helper that only calls `action()` once
the file is on disk; file downloads `res.sendFile()` the result and clean up the temp
file in the callback regardless of outcome.

### 2.7 Notifications

Not a fan-out broadcast — an ordered list of channels tried until one succeeds:

```js
async function notify(users, data) {
    for (let user of users.filter(Boolean)) {
        for (let stream of streams) {                // e.g. [socketStream, smsStream]
            if (await stream(user, data)) break;       // first success wins, stop trying others
        }
    }
}
```

Each transport's `setupXStream()` returns `(target, data) => Promise<boolean>`. Adding a
channel is: write the module, append it to the ordered `streams` array. Auth for the
socket transport travels in the handshake query string, same "auth is data" convention as
REST.

---

## 3. Frontend (Next.js App Router + React)

### 3.1 Layout

```
app/
  layout.js                    server component — metadata, delegates to layoutapp.js
  layoutapp.js                 "use client" — ONLY nests Context providers, no markup
  <route>/layout.js            role/scope boundary — wraps children in a Provider
  <route>/page.js               "use client" — reads Context, calls backendService
  <route>/_components/          components used only within this route subtree
components/
  <flat-file>.js                 generic, role-agnostic widgets
  ui/*.jsx                       shadcn/ui generated primitives
  <feature>/                     domain/role-specific component groups
context/<name>.js               createContext + Provider only — delegates ALL logic to the hook
hooks/<name>.js                 ALL useState/useEffect logic — no JSX, no createContext
services/
  backend/client.js              the ONLY place fetch() is called
  backend/<role>/<resource>.js   API calls, mirrors the backend's role-split structure exactly
  path/<role>/path.js            frontend route URL builders — kept separate from API calls
lib/utils.js                    cn() helper + the SAME shared constants as backend utils.js
```

### 3.2 `layout.js` vs `layoutapp.js`

`layout.js` is the Next.js special file — keep it a server component when possible, doing
only metadata + rendering a client wrapper. `layoutapp.js` is a project convention, not a
framework file: a `"use client"` component whose only job is nesting providers in a fixed
order, with zero markup of its own:

```js
export function AppLayout({ children }) {
    return <LanguageLayout><PWAProvider><NetworkLayout><ToastLayout>{children}
        </ToastLayout></NetworkLayout></PWAProvider></LanguageLayout>;
}
function ToastLayout({ children }) {
    const { dir } = useContext(LanguageContext);     // reads a value from an outer provider
    return <ToastProvider dir={dir}>{children}</ToastProvider>;
}
```

When one provider needs a value from another, add a small wrapper function like
`ToastLayout` that calls `useContext` on the outer one — don't reach across providers any
other way.

### 3.3 Context + hook pairing — strictly 1:1

```js
// hooks/<name>.js — logic only
export function use<Name>(<deps>) {
    const [<name>, set<Name>] = useState(null);
    const onUseEffect = useEffectEvent(() => { /* compute, then set<Name>(value) */ });
    useEffect(() => { onUseEffect(); }, [<deps>]);
    return { <name> };
}

// context/<name>.js — wiring only, never its own useState
export const <Name>Context = createContext(null);
export const <Name>Provider = ({ <deps>, children }) => {
    const { <name> } = use<Name>(<deps>);
    return <<Name>Context.Provider value={{ <name> }}>{<name> && children}</<Name>Context.Provider>;
};
```

Use `{<name> && children}` when children genuinely can't function without the value (e.g.
a user record); skip it when children should render an empty/loading state instead. Use
`useEffectEvent` for any effect that calls async logic or reads multiple state values — it
keeps the `useEffect` dependency array to just "what should retrigger this" while the
event body can freely reference the latest state without stale-closure bugs.

**Two distinct context families, don't merge their jobs**: `data/<role>` hooks bulk-fetch
and cache a role's dashboard records (parallel fetches, one updater per resource, plus a
combined `update()`); `portal/<role>` hooks do nothing but check "is this auth valid for
this role" and gate whether `children` render at all. Don't let fetching logic leak into a
portal hook, or auth-gating leak into a data hook. This mirrors the backend role split
(§2.3) on the client.

### 3.4 The API layer

```js
// services/backend/client.js — the only fetch() call site
export async function post(api, data) {
    try {
        const response = await fetch(`${process.env.URL_API}/${api}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
        });
        if (!response.ok) return getResult(false, response.statusText);
        return await response.json();
    } catch (error) {
        return getResult(false, error.message);    // network failure normalized to the SAME envelope
    }
}
```

Every backend-call function returns the same `{ success, output, data }` shape regardless
of whether the failure was a bad HTTP status or a thrown exception — callers check
`.success` once, never branch on "was it a network error or an API error." `auth` rides
inside the JSON body, not an `Authorization` header, matching the backend's `auth`-as-
first-argument convention.

```js
// services/backend/<role>/<resource>.js
export async function get<Resource>s(auth, scopeId) {
    return await client.post("<role>/<resource>/get-<resource>s", { auth, scopeId });
}
```

The path string must match the backend's mounted route exactly — there's no shared
constant between the stacks, so a typo here 404s silently into the normal failure envelope
instead of failing at compile time. Keep `services/path/**` (frontend navigation URLs,
used with `router.push`/`<Link>`) strictly separate from `services/backend/**` (API call
paths) even though both "build a string" — one is a UX concern, the other an API contract.

### 3.5 Error/loading state — no library, by design

```js
export function getDataFromResult(result, defaultData) {
    return (!result.success || !result.data) ? defaultData : result.data;
}
```

Every hook initializes state to an empty/falsy default, fetches, pipes the result through
this helper. There's no explicit `loading` boolean or `error` state — loading is inferred
from the value still being the default; failures are logged once in `client.js`. Don't
reach for React Query/SWR or a `{data,loading,error}` triple by default — only add it if
the project's UX genuinely needs visible loading/error states the empty-state inference
can't express.

### 3.6 Shared constants (`lib/utils.js`)

```js
export function cn(...inputs) { return twMerge(clsx(inputs)); }
export function getDataFromResult(result, defaultData) { /* see §3.5 */ }
// PLUS: the exact same EPOCH_*, ROLE_*, NOTIFY_* constants as backend/services/utils.js (§2.5.1)
```

### 3.7 UI components

Generate `components/ui/*` via the shadcn CLI, don't hand-author — `cva` for variants,
Radix primitives, a `cn()`-merged `className`, `data-slot` attributes. Plain
function-declaration components elsewhere, props destructured inline, no class components,
minimal-to-no comments.

---

## 4. Cross-cutting conventions

1. **One response envelope, no exceptions, on both stacks**: `{ success, output, data }`.
   This single convention is why neither stack needs try/catch sprinkled through business
   logic.
2. **A barrel `index.js` at every layer boundary** — import the barrel from outside its
   own directory; only import a sibling file directly within the same directory or to
   break a real circular-import edge case.
3. **Mirror role/resource structure across every layer that touches a resource**: backend
   controller ↔ backend route ↔ frontend service, same `<role>/<resource>` path in all
   three. Touching two of three without the third breaks the mirror.
4. **Identical formatting config on both stacks** (4-space indent, double quotes,
   semicolons, trailing commas, 120 cols) so contributors don't context-switch style
   between them.
5. **No automated tests by default** — a real gap, not a pattern to aspire to. Decide
   deliberately whether to add a test framework rather than silently inheriting the gap.

---

## 5. Build order

1. Decide roles/tenancy first — it determines whether you need the role-split pattern at
   all, and whether single-connection-plus-tenant-field or per-tenant-connection fits
   (§2.4).
2. Stand up the contract before any resource exists: `getResult()`, the barrels, the
   `client.js` error-normalization, the shared-constants file pair.
3. Build one full vertical slice for one resource end-to-end; copy its file set for every
   resource after.
4. When refactoring an existing app toward this structure, move resource-by-resource
   (schema + controller + route + frontend service + hook/context together), not
   layer-by-layer — keep the app runnable at every commit.
