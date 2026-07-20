# Pi Todo Transition Safety

## Problem

`todo_write` accepted a complete replacement array but did not compare it with the current list. Its prompt simultaneously required immediate completion and encouraged pruning, so models could omit the active item while promoting the next one. Restore compounded the risk by reading attempted assistant calls from all session entries instead of successful results from the active branch.

## Contract

- `update` is the default and preserves every existing item by normalized `content` identity. It may change status, order, or `activeForm`, and may add work.
- Completed items remain visible during normal progress.
- `replace` requires a non-empty list and a reason, and is reserved for direct user-requested replanning.
- `clear` requires an empty list. Clearing unfinished work also requires a reason and is reserved for a direct user request or abandoned work.
- Duplicate normalized content is invalid because content is the stable identity.
- Validation completes before the accepted snapshot replaces in-memory state.

This preserves compatibility for safe whole-list calls while turning destructive intent into an explicit, auditable operation.

## Persistence

State is restored from the latest successful `todo_write` tool-result `details.todos` snapshot on `SessionManager.getBranch()`. Attempted, failed, malformed, wrong-tool, and abandoned-branch entries are ignored. The same restore path runs for `session_start` and `session_tree`.

## Verification

Run:

```sh
node --test \
  configs/pi-agent/packages/pi-todo/extensions/todo/render.test.ts \
  configs/pi-agent/packages/pi-todo/extensions/todo/extension.test.mjs
```

Coverage includes missing-item rejection without mutation, stable completed history, explicit replace/clear rules, duplicate identities, successful-result extraction, divergent branch snapshots, and live `session_start`/`session_tree` restoration.
