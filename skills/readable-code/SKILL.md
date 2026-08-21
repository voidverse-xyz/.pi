---
name: readable-code
description: Write or refactor non-trivial code for human readability, review, and debugging. Use when logic includes meaningful state changes, data transformations, lifecycle behavior, or dense control flow; let project conventions and formatters override these defaults.
---

# Readable code

Prefer the smallest implementation that is easy to inspect, debug, and extend. Optimize for understanding rather than the fewest lines.

## Follow the local codebase

Read nearby code and applicable project instructions before introducing names or structure. Match established domain vocabulary, error contracts, module patterns, and formatting. Do not use this skill to justify unrelated cleanup.

## Name meaningful values and transitions

Give non-trivial queries, payloads, filters, configurations, and intermediate results names before the call that consumes them:

```js
const appointmentQuery = { patientId };
if (status != null) appointmentQuery.status = status;

const appointments = await appointmentStore.find(appointmentQuery);
```

Keep a short, complete literal inline when naming it would add no information.

Make repeated state transitions explicit. A named helper is often clearer than burying mutations in callback spreads:

```js
async function updateJob(id, patch) {
  await jobStore.update(id, (job) => (job ? { ...job, ...patch } : job));
}

await updateJob(jobId, { status: "failed", error: message });
```

## Keep control flow debuggable

- Prefer guard clauses when they keep the successful path flat.
- Use intermediate variables where a breakpoint or inspection point helps.
- Choose an explicit loop over a nested transformation chain when several steps or mutations must be understood together.
- Extract a helper when a block has a stable responsibility or repeats.
- Avoid clever one-liners that hide ordering, failure, or state changes.

A simple `map` or `filter` remains appropriate when its intent is immediate.

## Use structure and spacing to show intent

Group tightly related statements and separate meaningful phases such as validation, construction, execution, and result handling. Preserve useful spacing already present and let the formatter own mechanical layout.

Comments should explain constraints a future editor might otherwise violate—external behavior, required ordering, compatibility, or a non-obvious tradeoff. Do not narrate straightforward code.

## Keep state straightforward

- Give independently changing values independent names.
- Avoid opaque state bags and broad object spreads when they hide which fields changed.
- Keep state ownership near the narrowest component or module that needs it.
- Separate pure derivation from side effects where practical.
- Make initialization, cleanup, retry, and failure transitions visible.

In React, do not add `useMemo`, `useCallback`, `React.memo`, or ref workarounds without a concrete identity consumer or measured reason. Prefer direct state and data flow over speculative memoization.

## Refactor with a narrow purpose

Preserve readable existing structure unless changing it is part of the task. Do not combine a functional change with broad renaming, reformatting, or abstraction cleanup. Extract shared code only when its stable common shape is visible.

## Review the result

Before finishing, inspect the diff as a future reviewer:

1. Can each non-trivial block be summarized in one sentence?
2. Are important mutations, inputs, and failure paths visible?
3. Can useful intermediate state be inspected in a debugger?
4. Does the code match local conventions and formatter output?
5. Is every changed line necessary for the requested behavior?
