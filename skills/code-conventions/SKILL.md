---
name: code-conventions
description: Apply repository-aligned JavaScript, TypeScript, and React conventions for readable structure, imports, async work, state, modules, comments, and error contracts. Use when establishing conventions or making non-trivial JS/TS or React changes where local rules are unclear; skip for routine edits with an obvious nearby pattern.
---

# JavaScript and TypeScript conventions

Local repository rules are authoritative. Use this skill to preserve consistency, not to impose a universal house style.

## Establish the local convention

Before editing:

1. Read applicable instruction files.
2. Inspect formatter, linter, TypeScript, and package configuration.
3. Read nearby files that serve the same role.
4. Prefer generated or formatter-owned output over manual formatting opinions.

When configuration and legacy examples disagree, follow the active tooling for modified lines and avoid unrelated reformatting.

## Keep the shape simple

- Prefer the smallest correct implementation over a new abstraction.
- Keep code in one function until part of it has a concrete reusable or composable responsibility.
- Do not add compatibility paths without persisted data, shipped consumers, or an explicit requirement.
- Build non-trivial queries, payloads, filters, and configuration objects in named variables before passing them to a call.
- Preserve blank lines between validation, construction, execution, and result handling.

## Formatting and imports

- Let the configured formatter decide indentation, quotes, semicolons, trailing commas, and line wrapping.
- Preserve import grouping and ordering used by nearby files or enforced by lint rules.
- When the repository provides no import-order convention, put wrapped multi-line import blocks first, alphabetize imported members, then arrange single-line imports roughly from shortest to longest.
- Keep directives such as `"use client"` or shebangs in their required positions.
- Remove unused imports and avoid introducing aliases that obscure module ownership.
- Do not reorder or reformat untouched code merely to make the whole file uniform.

## Names and declarations

- Reuse the domain vocabulary already present in types, APIs, tests, and neighboring modules.
- Use `const` by default and `let` when reassignment expresses real state change.
- Follow the repository's convention for exported functions, components, hooks, constants, and filenames.
- Avoid generic names such as `data`, `item`, or `handler` when a stable domain name is available.

## Control flow

- Prefer guard clauses when they keep the successful path flat.
- Extract a helper when a block has a distinct responsibility or is repeated.
- Choose loops, array methods, or reducers based on clarity; do not compress stateful logic into a dense chain.
- Keep mutations visible and close to the values they change.
- Preserve existing return and error contracts rather than inventing a new envelope or exception style.

## Async and concurrency

- Use the project's established promise style; prefer `async`/`await` for multi-step flows.
- Land an awaited value in a named variable before passing it to another call; do not nest `await` inside call arguments.
- Run independent operations concurrently only when ordering, resource limits, and failure behavior allow it.
- Await required work before returning. Explicitly mark intentional background work and give failures an owner.
- Preserve cancellation, timeout, cleanup, and transaction boundaries.

## React state and identity

- Use one named `useState` call per value rather than a string-keyed state bag or state generated from a roster.
- Return object fields explicitly rather than spreading a state bag into the result.
- Introduce `useMemo`, `useCallback`, `React.memo`, or a ref workaround only when referential identity has a real consumer.
- Prefer two specific functions over one general function held together by refs.
- When a hook wraps one behavior, return that behavior directly rather than an object with one key.
- Let small hooks own their internal machinery so callers pass ordinary identifiers and receive ordinary values.

## Comments

Do not add comments that restate code, narrate a straightforward algorithm, or carry task background that belongs in the change report. Reserve source comments for constraints a future reader could otherwise break, such as ordering dependencies or external platform defects.

## Modules and public APIs

- Match the repository's ESM or CommonJS convention.
- Keep exports intentional; do not expand a public barrel unless consumers need the symbol.
- Avoid circular dependencies and hidden initialization side effects.
- Update types, schemas, callers, and tests when changing a public contract.

## Scope and verification

Keep the diff focused. Do not mix behavioral changes with broad formatting or naming cleanup unless requested.

Before finishing:

1. Run the configured formatter on touched files.
2. Run focused lint, type, and test commands.
3. Inspect the diff for accidental churn, unused code, and inconsistent error handling.
4. Explain any deliberate deviation from local conventions.
