# Backend, output-context, and document integration

## Locale resolution at request boundaries

Resolve locale from trusted and explicit sources in this order unless product requirements say otherwise:

1. Authenticated user's saved locale.
2. Session/tenant preference.
3. Explicit request locale after allowlist resolution.
4. Parsed `Accept-Language` preferences.
5. Application default.

Never use a raw locale string to construct a filesystem path or dynamic import. Resolve it through the registered catalog map first.

Prefer machine-readable error codes in service/domain layers. Localize at the HTTP, job, email, CLI, or UI boundary where the recipient and output channel are known. If the existing application returns localized domain results, pass the resolved locale explicitly and keep the error code alongside the human message.

## Validation messages

Do not embed one language's prose inside validation functions. Return a stable code and parameters:

```js
return { ok: false, code: "invalid_email", params: {} };
```

At the delivery boundary:

```js
const message = i18n.t(locale, result.code, result.params);
```

This keeps validators testable and prevents background jobs or APIs from choosing the wrong recipient language.

## Email

Generate both text and HTML variants. Translation messages should be plain text by default.

- Escape interpolated values for the HTML context before inserting them into HTML templates.
- Validate and constrain links separately; HTML escaping does not make an arbitrary URL safe.
- Do not let translators inject arbitrary tags unless the translation system has an explicit, audited rich-text representation.
- Keep subjects free of markup.
- Preview representative long strings, RTL content, and non-Latin scripts.

A safe pattern is to translate plain fields first, then pass them to an email renderer that escapes by default.

## Rich UI text

Avoid storing executable HTML in catalogs. For links, emphasis, and components:

- Split the sentence into semantic message parts; or
- Use a framework-native rich-text formatter with an allowlisted component map.

Never use an untrusted translation string with `innerHTML`/`dangerouslySetInnerHTML`.

## Numbers, dates, times, lists, and pluralization

Use `Intl.NumberFormat`, `Intl.DateTimeFormat`, `Intl.ListFormat`, and `Intl.PluralRules`. Keep raw values in application state and format at the presentation boundary.

- Store timestamps in an unambiguous machine format and choose the recipient's time zone explicitly.
- Do not infer currency from language alone; locale and currency are separate product/account settings.
- Use named placeholders because translators may reorder phrases.
- Every plural map needs an `other` branch. Exact branches such as `=0` are optional overrides.

## PDFs and generated documents

Prefer embedding fonts that cover every supported script. Falling back to another language because a font lacks glyphs should be a last resort, not the default architecture.

Verify:

- Font licensing permits embedding.
- Shaping and bidirectional layout work for the target script.
- Line wrapping survives translated expansion.
- The document's metadata and accessibility language are set where supported.

If a product explicitly accepts a fallback document language, model it as separate output-channel policy rather than silently changing the user's UI locale.

## Catalog loading and deployment

- Load catalogs deterministically and fail startup/build validation on duplicate IDs, invalid shapes, or missing defaults.
- Run `scripts/validate-catalogs.mjs` in CI for every catalog set.
- Include catalog changes in cache/version invalidation.
- Do not rely on runtime directory scanning in environments that bundle or edge-deploy code; use build-time imports or generated manifests there.
- Keep one authoritative list/manifest per deployable catalog set so a language cannot exist on disk but remain unreachable.

## Observability

Log missing keys and fallback use without recording translated user content or sensitive interpolation values. In production, aggregate by locale and key so missing coverage is actionable without leaking payloads.
