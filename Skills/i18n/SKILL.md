---
name: i18n
description: Translation/localization conventions for this repo — every user-facing string goes through a translation key, defined in all language files, on both backend and frontend. Use whenever adding or changing any message a user sees (success/error/validation text), adding a translation key, or adding a language.
---

# Internationalization (i18n)

This app is fully localized. **No user-facing string is hardcoded** — every message returned in
a `getResult` output, every validation/error message, and every UI label resolves through a
translation key. Supported languages: `en`, `fr`, `es`, `jp`, `ar` (note `ar` is RTL — `dir: "rtl"`).

> **Follow these conventions when possible — they are the default, not an absolute law.** If you
> think a different approach is genuinely better for a case, don't silently diverge and don't
> blindly conform: explain to the user *why* the alternative is clearly better, with concrete
> reasons, and confirm before doing it. When there's no clear win, follow the convention.

## Backend

Language files live in `backend/languages/<lang>.json`. Each file is an object with
`id`, `name`, `dir`, `pdfLangId`, `locales` (a list of matched BCP-47 locales) and a
`translations` map of key → string.

Resolve strings with `backend/services/language.js`:

- `t(langId, "key", ...args)` — primary helper; use in base controllers (you have `langId`).
- `tu(user, "key", ...args)` — when you hold a user object (`user.langId`).
- `tuid(userId, "key", ...args)` — async; looks up the user's `langId` by id.

Example: `return getResult(true, t(langId, "doctor_create_exercise_success"), id);`

### Argument substitution & plurals

- Positional args: `{{1}}`, `{{2}}` ... map to the extra args passed to `t`.
- Arg objects `{ date }` / `{ epoch }` are auto-formatted to the locale.
- Plurals use `[[index,default,value:plural,...]]` syntax (see `parsePlurals`).
- The service logs an error if a rendered string still contains `{{`/`[[` markers — keep
  placeholders consistent across every language file.

## Frontend

Mirror files in `frontend/src/lib/languages/<lang>.js`, loaded via
`frontend/src/lib/languages/loader.js`, with `services/language.js` + the `hooks/language.js` /
`context/language.js` pair for runtime access. Use the language context/hook to translate UI
strings rather than inlining text.

## Key naming convention

- Success: `<role>_<action>_<entity>_success` — e.g. `doctor_create_exercise_success`,
  `doctor_remove_content_success`.
- Validation: `invalid_<thing>` — e.g. `invalid_exercise_name`, `invalid_email`, `invalid_auth`.
- Errors: `error_<thing>` — e.g. `error_exercise_inuse`, `error_upload_failed`.

## Rules when adding/changing a string

1. Pick or create a key following the convention above.
2. Add the key to **every** language file — both `backend/languages/*.json` and
   `frontend/src/lib/languages/*.js`. Missing keys are logged as errors at runtime.
3. Keep `{{n}}` / `[[...]]` placeholders identical across all languages.
4. Reference the key via `t` / `tu` / `tuid` (backend) or the language hook (frontend) —
   never return or render a raw literal.

## Adding a language

Add a new `<lang>.json` (backend) and `<lang>.js` (frontend) replicating an existing file's
full key set, with correct `id`, `name`, `dir`, `pdfLangId`, and `locales`. RTL languages set
`dir: "rtl"`.
