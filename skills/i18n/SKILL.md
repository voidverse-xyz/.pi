---
name: i18n
description: Preserve an existing application's internationalization system when adding or changing user-visible text, validation messages, formatting, locales, or directionality. Use for frontend or backend localization work; follow the project's catalogs, fallback rules, and translation API.
---

# Internationalization changes

Use the localization system already present in the project. This skill does not prescribe a framework or require localization where the product has intentionally chosen otherwise.

## Discover the localization contract

Before editing:

1. Find the translation API used at the relevant frontend or backend boundary.
2. Locate the source catalogs and determine which are authoritative, generated, or fallback-only.
3. Inspect key naming, interpolation, plural, date, number, list, and directionality conventions.
4. Find validation or tests that check catalog completeness and placeholder consistency.
5. Determine whether server and client share catalogs or maintain separate message domains.

## Add or change user-visible text

- Reuse an existing key when the meaning and placeholders match exactly.
- Otherwise add a stable, semantic key using the project's naming convention.
- Update every catalog required by the project's completeness policy. Do not fabricate translations when accurate translation is unavailable; use the established fallback or clearly identify the untranslated locale.
- Keep placeholder names, types, and plural variables consistent across locales.
- Pass dynamic values as interpolation arguments rather than concatenating translated fragments.
- Keep developer-only logs, protocol identifiers, and internal diagnostics out of catalogs unless users see them.

Do not replace a project's named placeholders with positional placeholders, or vice versa, without updating all callers and validation.

## Formatting and grammar

Use locale-aware formatters for dates, times, numbers, currencies, percentages, lists, and relative time. Use the project's plural/select mechanism rather than branching on English grammar in application code.

Avoid composing sentences from independently translated fragments when word order can differ by language. Give translators enough context through the project's supported comments or metadata.

## Frontend and backend boundaries

- Resolve UI labels through the frontend translation mechanism.
- Resolve user-facing backend errors or messages at the established boundary, using the request or account locale.
- Keep machine-readable error codes stable when clients depend on them; localize presentation separately when that is the project contract.
- Preserve server-rendering and hydration behavior when locale affects initial markup.

## Locale and directionality support

When adding a locale, verify:

- Locale identifiers and negotiation aliases.
- Fallback behavior.
- `lang` and text direction (`ltr` or `rtl`).
- Font and layout support where relevant.
- Formatting behavior for representative values.
- The complete required key set.

Do not assume language codes, supported locales, or right-to-left behavior from another project.

## Verify

Run available catalog validation and focused tests. At minimum check:

1. Missing and extra keys according to project policy.
2. Placeholder and plural-variable parity.
3. Fallback behavior for an absent translation.
4. Representative interpolation and plural cases.
5. Frontend rendering or backend response behavior.
6. Directionality when an RTL locale is supported.
