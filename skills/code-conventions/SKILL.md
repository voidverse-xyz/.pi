---
name: code-conventions
description: Formatting and import-ordering conventions for this repo (backend Node + frontend Next.js). Use whenever writing or editing any .js file — ordering imports, choosing quotes/indentation, declaring functions/constants, or shaping return values. Apply before saving any new or modified file.
---

# Code conventions

These rules are enforced by Prettier (`.prettierrc` in `backend/` and `frontend/`) plus
hand-maintained conventions. Match them in every file you touch.

> **Follow these when possible — they are the default, not an absolute law.** If you believe a
> different approach is genuinely better, don't silently diverge and don't blindly conform:
> tell the user *why* the alternative is clearly better, with concrete reasons, and confirm
> with them before going that way. When there's no clear win, follow the convention.

## Formatting (Prettier)

- **4-space** indentation.
- **Double quotes** for strings.
- **Semicolons** always.
- **Trailing commas** everywhere (`"trailingComma": "all"`).
- **120** char print width.
- Run/respect Prettier; never hand-format against it.

## Import ordering — the rule

Imports sit at the very top, are split into blank-line-separated groups, and **within each
group lines are sorted by total line length, ascending (shortest → longest)**. One blank line
separates the whole import section from the code body.

Grouping (a blank line between each group that exists):

1. In frontend client files, `"use client";` is the **first line**, then a blank line.
2. Third-party / Node built-in packages (bare module names like `express`, `fs`, `react`).
3. Local imports (`./`, `../`, `@/`).

Example (`backend/services/utils.js`) — note ascending length:

```js
import fs from "fs";
import multer from "multer";
import { tu } from "./language.js";
import { ZipArchive } from "archiver";
import * as crypto from "node:crypto";
import { authService, directoryService, loggerService } from "./index.js";

export const SALT_ROUNDS = 10;
```

Frontend example (`frontend/src/context/training.js`):

```js
"use client";

import { createContext } from "react";
import { useTraining } from "@/hooks/training";

export const TrainingContext = createContext(null);
```

When adding an import, insert it at the position that keeps the group length-sorted — do not
just append to the end.

> A handful of older files sort a group descending. That is legacy; new/edited code follows
> ascending. Don't "fix" an untouched file's order, but keep the file you're editing consistent.

## Vertical spacing & grouping

Code is "paragraphed": **a single blank line separates each logical step**, while tightly
related statements stay packed together with no blank line. Read a function as a sequence of
small blocks — declare/validate, do, respond/return — each its own paragraph.

Conventions seen throughout:

- One blank line after the import block (before the first code), and one before a `return` that
  follows real work.
- Group statements that form one step; separate the next step with a blank line. Don't blank-line
  between every line, and don't run unrelated steps together.
- Statements that act as a unit stay adjacent (e.g. `res.send(result)` immediately followed by
  `logResult(req, result)`; consecutive field assignments on a doc).
- Module-level constants are grouped by topic, each group separated by a blank line (see
  `EPOCH_*`, `ROLE_*`, `NOTIFY_*` blocks in `backend/services/utils.js`).

Route handler — note the four paragraphs (rate-limit / parse+sanitize / call / respond):

```js
router.post("/create-exercise", async (req, res) => {
    await limit(req, res);

    let json = req.body ?? {};
    let auth = sanitizeService.text(json.auth);
    let name = sanitizeService.text(json.name);

    let result = await exerciseController.doctor.createExercise(auth, name);

    res.send(result);
    logResult(req, result);
});
```

Base controller — validate / build / mutate / return, each separated:

```js
export async function createExercise(doctorId, langId, name) {
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

## Naming & declarations

- Module-level constants: `UPPER_SNAKE_CASE`, `export const`, grouped by topic with blank
  lines between groups (see `backend/services/utils.js`, `frontend/src/lib/utils.js`).
- Exported logic: named `export function foo() {}` declarations (not arrow consts) at module scope.
- Files are lowercase, single word where possible (`exercise.js`, `caregiver.js`).
- Index aggregators (`index.js`) re-export sibling modules with a namespace + role/suffix,
  **alphabetically sorted**:
  - services: `export * as authService from "./auth.js";`
  - controllers: `export * as exerciseController from "./exercise.js";`
  - schemas: `export * as exerciseSchema from "./main/exercise.js";`
  Consume them via `import { authService } from "./index.js";` then `authService.method()`.

## Result envelope

Every controller/service/API function returns the same shape via `getResult`:

```js
return getResult(success /* bool */, output /* user-facing string */, data /* optional */);
// => { success, output, data }
```

`getResult` lives in `backend/services/utils.js` and `frontend/src/lib/utils.js`. Always return
it (success and failure) rather than throwing across layer boundaries.

## Control flow & function design

The code reads top-to-bottom and stays flat. Match this — it is the dominant style (the entire
backend has only a handful of `else` statements).

### Guard clauses, return early — avoid deep nesting

Check the failure/edge case first and **return early**; keep the happy path at the base
indentation. Don't wrap the main logic in an `if`, and **avoid `else`** — prefer an early
`return` (or `continue` in loops). As a rule of thumb, **don't nest conditionals more than ~2
levels**; if you're heading for a third, extract a function or invert a condition into a guard.

```js
// preferred — guards then happy path
export async function createExercise(doctorId, langId, name) {
    let validation = {};
    if (!validationService.text(name, validation, langId, "invalid_exercise_name")) {
        return getResult(false, validation.output);
    }

    let model = getModelMain(exerciseSchema);
    let doc = await model.findOne({ _id: id }).exec();
    if (!doc) {
        return getResult(false, t(langId, "invalid_exercise"));
    }

    // ... happy path at base indentation
}
```

```js
// avoid — nested success branches / else
if (validation) {
    if (doc) {
        // logic buried two levels deep
    } else {
        return getResult(false, ...);
    }
}
```

In loops, skip with `continue` instead of wrapping the body in an `if` (see
`convertObjectToModelObject`, `generateRandomPassword` in `backend/services/utils.js`).

### Small, single-responsibility functions

Each function does one thing and is short. When logic repeats inside a function, extract a
**local helper** rather than copy-pasting or nesting (e.g. `removeFiles` inside
`deleteUserAccount` in `backend/controllers/base/user.js`, `validateCheck` in
`backend/services/validate.js`). Pull cross-cutting concerns into a service in
`backend/services/` and call it.

### No callback hell — async/await everywhere

Use `async`/`await` with flat, sequential statements. Do **not** nest callbacks or chain
`.then()`. Patterns in use:

- Sequential work: a flat list of `await` lines, or `for (const x of items) { await ... }`.
- Parallel work: collect promises then `await Promise.all(tasks)` (see
  `getExercises` in `backend/controllers/base/exercise.js`).
- Wrap a genuinely callback-based API once in a `new Promise(...)` and `await` it (see
  `compress` in `backend/services/utils.js`); don't let callbacks leak into business logic.
- Extract named handlers instead of inlining deep callbacks (e.g. `getAuthentication`,
  `handleError` in the notify/socket code), and return tuples like `return [valid, auth, user]`
  when a helper yields several values.

### Idioms

- `??=` for lazy one-time init (`global.globalThis.multerHandle ??= ...`, `window[key] ??= 0`).
- Optional chaining `?.` and nullish `??` for defaults instead of nested existence checks.
- Array methods (`map`/`filter`/`find`/`some`) and spreads (`[...arr]`) over manual index loops
  where it reads cleanly.
- Backend declares mutables with `let`; frontend prefers `const`. Match the file you're in.
