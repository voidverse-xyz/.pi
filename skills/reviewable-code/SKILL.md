---
name: reviewable-code
description: Write code that survives review — favor human readability and easy debugging. Use when writing or refactoring non-trivial logic, especially data/state mutations, dense functional chains, or anything a reviewer must reason about. Apply before opening a PR.
---

# Reviewable code

Lessons distilled from real PR review feedback. The goal: a reviewer (or future you,
mid-debugging) can tell *what the code does* at a glance, without unpacking it.

## 1. Name your data/state mutations — don't bury them in inline callbacks

Mutating a document/record inside an inline spread callback hides *what actually changes*:

```js
// ❌ Hard to see the transition; repeated at every call site.
await db.update(coll, id, (f) => (f ? { ...f, status: "failed", error: msg, output: null } : f));

// ✅ A named helper makes each call read as "set these fields".
async function patchFile(id, patch) {
    await db.update(coll, id, (f) => (f ? { ...f, ...patch } : f));
}
await patchFile(id, { status: "failed", error: msg, output: null });
```

When the same inline-mutation shape repeats, extract one helper and route every transition
through it. Bonus: the null-guard lives in one place.

## 2. Prefer an explicit loop over a dense functional chain when it aids reading

Chained `flatMap`/`map`/`filter`/spreads are elegant until they nest. If a reviewer has to
hold several transforms in their head — or you can't set a breakpoint on the interesting
step — unroll it:

```js
// ❌ Dense: nested flatMap + spread + trailing filter.
return new Set(files.flatMap((f) => [...(f.results || []).map((r) => r.out), f.current]).filter(Boolean));

// ✅ Explicit: each step is its own line; trivially debuggable.
const out = [];
for (const f of files) {
    for (const r of f.results || []) out.push(r.out);
    out.push(f.current);
}
return new Set(out.filter(Boolean));
```

This is a judgment call — a single `.map().filter()` is fine. Unroll when nesting or
multiple transforms make the intent hard to follow.

## 3. Optimize for the debugger, not just the eye

Favor shapes you can breakpoint and inspect: intermediate named variables over one long
expression; early returns over deep nesting; descriptive names over clever one-liners.

## 4. Match the project's own style — don't fight its formatter

Style nits in review (single-line vs multi-line, etc.) are usually the **project's
convention or its formatter (Prettier), not an eslint rule** — diagnose which before
"fixing eslint." Follow the repo's documented convention (`AGENTS.md`/`CLAUDE.md`); if a
reviewer's preference conflicts with it, surface the conflict rather than silently changing
the rules. If you must override the formatter for one line, `// prettier-ignore` is the
honest tool.

## Before opening a PR

Skim your diff as a reviewer: for each non-trivial block, can you say what it does in one
sentence? If not, name it, unroll it, or add the variable that makes it obvious — *before*
the review, not after.
