---
name: custom-i18n-system
description: Design, build, or port a small project-owned internationalization system without adopting a full i18n framework. Covers project-agnostic language catalogs, locale negotiation and fallback, named interpolation, CLDR plural rules through Intl, number/date/list formatting, RTL/LTR and document language, browser/account persistence, backend errors and emails, catalog validation, SSR, and font-aware document generation. Use only when the user explicitly requests a custom/dependency-light i18n engine, must preserve an existing custom architecture, or cannot use a maintained i18n library; do not trigger for routine translation edits in a project that already has an i18n system.
---

# Custom i18n system

Build a compact, project-owned internationalization layer using platform standards rather than recreating a large framework badly.

## Use this only for the right problem

A maintained library is normally the better choice. Recommend the ecosystem-standard option when the user simply asks to internationalize an application: established libraries provide message extraction, ICU syntax, framework integration, locale data, tooling, and translator procedures.

Use this skill when at least one is true:

- The user explicitly wants no/full-framework dependency.
- An existing custom i18n contract must be preserved or ported.
- The runtime is small or constrained and `Intl` plus a compact catalog layer is enough.
- The project needs the same small engine in multiple boundaries (for example browser, API, jobs, email and CLI) without framework coupling.

Do not replace an existing working i18n system merely for stylistic consistency. For routine key additions or translation fixes, follow the target project's existing i18n guidance instead.

## Architecture

Keep the core independent from React, databases, HTTP and filesystem loading:

```text
JSON/module catalogs
        │
        ▼
custom i18n core
  resolve locale + fallback
  lookup + named interpolation
  Intl plural/number/date/list formatting
        │
        ├── browser/framework adapter
        ├── backend/request adapter
        ├── jobs/email adapter
        └── document/export adapter
```

The provided `assets/i18n-core.mjs` follows this shape. It creates isolated instances rather than mutable global state, which makes tests and multi-tenant/server usage safer.

## 1. Confirm requirements before coding

Establish:

- Supported locales and default locale.
- Whether locale is chosen per user, session, tenant, request, device, or some combination.
- Browser-only, SSR, backend, CLI, email, PDF/document, or multi-runtime use.
- Whether frontend and backend share one catalog or intentionally maintain different message sets.
- Required plural, number, currency, date/time, time-zone and list formatting.
- RTL scripts and font/shaping requirements.
- Who edits translations and whether they need JSON, PO/XLIFF, spreadsheets, or a translation platform.
- Rich-text requirements and permitted markup/components.
- Missing-key behavior in development and production.
- Accessibility, SEO and document-language requirements.

If the needs include complex ICU messages, extraction, translator collaboration or many locales, revisit the library decision before proceeding.

## 2. Inspect and reuse the target project

Before creating files:

- Find existing locale fields, middleware, catalogs, formatting helpers and language selectors.
- Trace how authenticated preferences, anonymous sessions and request headers flow.
- Identify SSR/hydration boundaries and caching.
- Find every output channel that emits user-visible text: UI, API errors, email, notifications, logs intended for users, PDFs and exports.
- Follow project naming, directory, testing and state-management conventions.

Adapt the provided assets to those conventions; do not impose their example paths.

## 3. Define the catalog contract

Prefer plain JSON unless a runtime genuinely requires module values. A catalog should contain:

```json
{
  "id": "en",
  "name": "English",
  "dir": "ltr",
  "locales": ["en-US", "en-GB"],
  "messages": {
    "welcome": "Welcome, {{name}}.",
    "items": {
      "=0": "No items",
      "one": "{{count}} item",
      "other": "{{count}} items"
    }
  }
}
```

Rules:

- Use canonical BCP-47 locale identifiers.
- Use named placeholders; translators must be free to reorder sentence parts.
- Use nested or flat keys consistently. Keys describe meaning, not the original English sentence.
- A plural value is a map of CLDR categories (`zero`, `one`, `two`, `few`, `many`, `other`) with required `other`; exact branches such as `=0` are optional.
- Keep executable code and arbitrary HTML out of catalogs.
- Keep key and placeholder sets aligned across every locale in a catalog set.
- Frontend and backend catalogs may differ when their messages serve different audiences, but validate each set independently.

Copy and adapt `assets/catalogs/` as a minimal example.

## 4. Implement locale resolution deliberately

Use an explicit precedence order. A typical browser application is:

1. Authenticated user's saved preference.
2. Session or tenant preference.
3. Local browser preference.
4. `navigator.languages` / parsed `Accept-Language` candidates.
5. Application default.

Resolve every candidate through registered catalog IDs and aliases. Never use an unvalidated locale to build a path or dynamic import.

Support exact and base-language fallback (`es-MX` → `es`) before the application default. Make fallback observable in development so missing regional coverage is not silently ignored.

For SSR, resolve the locale on the server and pass it to the client provider. Reading browser storage only after hydration can render different server/client text and cause hydration errors.

## 5. Use standards for linguistic formatting

Do not invent a plural DSL. Use:

- `Intl.PluralRules`
- `Intl.NumberFormat`
- `Intl.DateTimeFormat`
- `Intl.ListFormat`
- `Intl.RelativeTimeFormat` when needed

Locale does not determine currency or time zone by itself. Obtain those from product/account context.

The core asset exposes translation plus number/date/list helpers. Add more `Intl` wrappers only when the project needs them.

## 6. Integrate the frontend

For React, adapt `assets/react-language-provider.jsx`:

- Initial resolution honors a server/session `userLocale` before browser fallback.
- A later account preference overrides local detection without being overwritten by a mount effect.
- Explicit user selection updates local storage and can call an async persistence callback.
- Both `<html lang>` and `<html dir>` are updated.
- Translation and formatting helpers are bound to the active locale.

For another framework, reproduce the contract with its native state/context mechanism rather than copying React.

Language selectors must:

- Use localized or native language names as the product requires.
- Expose an accessible label.
- Avoid flags as the sole representation of language.
- Persist only a resolved supported locale.
- Show persistence errors when the backend save fails instead of pretending the account preference changed.

## 7. Integrate backend and other output channels

Read `references/backend-and-security.md` before implementing backend validation, email, rich content or documents.

Prefer stable error codes and parameters in domain/service layers, then localize where the recipient and output channel are known. Authenticated user's saved locale should normally outrank a client-supplied locale.

For emails and HTML:

- Translate plain values, then render through an escaping template layer.
- Do not place arbitrary executable HTML in translation catalogs.
- Validate links independently from HTML escaping.

For PDFs/documents, embed fonts covering supported scripts and verify shaping/bidirectional layout. Do not silently switch a user's language merely because the chosen font lacks glyphs.

## 8. Load catalogs in a runtime-appropriate way

- Node/server runtime with filesystem access: adapt `assets/load-json-catalogs.mjs`, which uses deterministic `readdirSync` rather than a version-specific glob API.
- Bundled frontend: use a build-time glob or generated manifest supported by the bundler.
- Edge/serverless bundle: use static imports or build-time generation; runtime directory scanning may not exist.

Keep one authoritative catalog manifest per deployable set. A file present on disk but absent from the runtime manifest is a build failure, not an acceptable silent state.

## 9. Validate catalogs automatically

Copy `scripts/validate-catalogs.mjs` with the assets it imports, then run:

```bash
node scripts/validate-catalogs.mjs <catalog-directory> <default-locale>
```

It checks:

- Catalog shape and BCP-47 identifiers.
- Duplicate IDs/aliases.
- Missing and extra message keys.
- Text-vs-plural type drift.
- Placeholder parity.

Run it in CI and before releases. Add product-specific checks for forbidden HTML, maximum length, required metadata or translator status when needed.

## 10. Test the full lifecycle

Cover at minimum:

1. Exact locale, regional alias, base-language and default fallback.
2. Missing key in selected locale and missing key everywhere.
3. Named interpolation and missing parameter diagnostics.
4. Plural categories relevant to each supported language, plus exact `=0` if used.
5. Number, currency, date, time-zone and list formatting.
6. Saved account locale, anonymous storage and browser negotiation precedence.
7. SSR/hydration with and without a known server locale.
8. Explicit language selection and backend persistence failure.
9. RTL direction and document `lang` updates.
10. Long translations, UI expansion and truncation.
11. Email text/HTML escaping and safe links.
12. PDF/document glyph coverage, shaping, wrapping and metadata.
13. Catalog validator failure for missing keys and placeholder drift.
14. Startup/build behavior with an invalid or empty catalog set.

## Deliverable checklist

- [ ] Requirements and library-vs-custom decision recorded.
- [ ] Catalog schema and default locale defined.
- [ ] Runtime-specific loader chosen.
- [ ] Core engine remains framework-independent.
- [ ] Locale precedence and fallback implemented.
- [ ] Named interpolation and `Intl` formatting implemented.
- [ ] Catalog parity validation runs automatically.
- [ ] Frontend sets document `lang` and `dir`.
- [ ] Account/session persistence handles errors honestly.
- [ ] Backend and outbound channels resolve the recipient locale.
- [ ] Rich text and HTML use context-appropriate escaping.
- [ ] Fonts/scripts verified for generated documents.
- [ ] Lifecycle and edge-case tests pass.

## Included resources

| Resource | Purpose |
|---|---|
| `assets/i18n-core.mjs` | Framework-independent engine with locale fallback, named interpolation, plural selection and `Intl` formatters. |
| `assets/load-json-catalogs.mjs` | Deterministic Node JSON catalog loader. |
| `assets/react-language-provider.jsx` | React provider with corrected initialization/persistence ordering and document metadata. |
| `assets/catalogs/en.json`, `es.json` | Minimal parity-valid example catalogs. |
| `scripts/validate-catalogs.mjs` | Dependency-free catalog/key/placeholder validator. |
| `references/backend-and-security.md` | Backend boundary, email/HTML, formatting, PDF/font, loading and observability guidance. |

Read and adapt only the resources relevant to the target stack. They are starting points, not a directory layout mandate.
