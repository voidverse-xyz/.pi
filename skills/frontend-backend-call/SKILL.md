---
name: frontend-backend-call
description: How to call the backend from the Next.js frontend and wire React state in this repo — the services/backend client layer (mirrors backend routes), plus the paired hooks/ + context/ pattern. Use whenever adding or editing files under frontend/src/services/backend, frontend/src/hooks, or frontend/src/context.
---

# Frontend backend calls & state

The frontend mirrors the backend's layering. Every backend route has a matching client
function, and React state is delivered through paired hook + context modules.

> **Follow this pattern when possible — it's the default, not an absolute law.** If a different
> approach is genuinely better for a case, don't silently diverge and don't blindly conform:
> explain to the user *why* the alternative is clearly better, with concrete reasons, and confirm
> before doing it. When there's no clear win, follow the convention.

All client/state files start with `"use client";` as the first line (then a blank line).

## Backend service layer (`frontend/src/services/backend/`)

Structure mirrors the backend exactly:

```
services/backend/<entity>.js          re-exports role namespaces
services/backend/<role>/<entity>.js   one function per endpoint
services/backend/client.js            get / post / upload / download wrappers
```

Entity file:

```js
"use client";

export * as admin from "./admin/exercise";
export * as doctor from "./doctor/exercise";
```

Role file — build the `data` object, then `client.post` to the **same path the backend mounts**
(`<entity>/<role>/<endpoint>`):

```js
"use client";

import * as client from "@/services/backend/client";

export async function createExercise(auth, name, properties) {
    const data = {
        auth,
        name,
        properties,
    };

    return await client.post("exercise/doctor/create-exercise", data);
}
```

- `client.js` (`post`/`get`/`upload`/`download`) prefixes `process.env.URL_API`, sets headers,
  and on any failure returns the `getResult(false, ...)` envelope. So callers always receive
  `{ success, output, data }` — handle `result.success`/`result.output`/`result.data`, never throw.
- The path string passed to `client.post` must match the backend mount
  (`routes/routes.js` prefix + sub-router + handler path) character-for-character.

## State: paired hooks + context (`frontend/src/hooks/`, `frontend/src/context/`)

For each piece of state there is a hook and a context with the **same filename**
(`hooks/training.js` ↔ `context/training.js`). Also organized into `data/<role>.js` and
`portal/<role>.js` subfolders for role-scoped state.

Hook — `use<Name>` returning an object, using `useState` + `useEffect` with `useEffectEvent`
for effect bodies that read props/state without widening the dependency array:

```js
"use client";

import { useEffect, useEffectEvent, useState } from "react";

export function useTraining(auth, trainingId, trainings) {
    const [training, setTraining] = useState(null);

    const onUseEffect = useEffectEvent(() => {
        let found = trainings.find((x) => x._id === trainingId);
        if (!found) {
            return;
        }
        setTraining(found);
    });

    useEffect(() => {
        onUseEffect();
    }, [auth, trainingId, trainings]);

    return { training };
}
```

Context — `createContext` + a `<Name>Provider` that calls the hook and exposes its value.
Providers commonly render `children` only once the data is ready:

```js
"use client";

import { createContext } from "react";
import { useTraining } from "@/hooks/training";

export const TrainingContext = createContext(null);

export const TrainingProvider = ({ auth, trainingId, trainings, children }) => {
    const { training } = useTraining(auth, trainingId, trainings);

    return (
        <TrainingContext.Provider value={{ training }}>
            {training && children}
        </TrainingContext.Provider>
    );
};
```

## Helpers

- `@/lib/utils` holds shared constants and helpers (`getResult`, `getDataFromResult`,
  `cn` for Tailwind class merge, role/epoch constants). Reuse these instead of re-deriving.
- Use the `@/` alias for `frontend/src` imports.

## Checklist to add a frontend call

1. Add the function in `services/backend/<role>/<entity>.js` (build `data`, `client.post(path)`).
2. Make sure the entity re-export (`services/backend/<entity>.js`) covers the role namespace.
3. Consume the result through the matching hook/context; if it's new state, create the paired
   `hooks/<name>.js` + `context/<name>.js` (or under `data/`/`portal/`).
4. Follow `code-conventions` for `"use client";`, import ordering, and the `getResult` envelope.
