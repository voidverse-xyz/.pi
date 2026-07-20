# Transition-Safe Snapshot Tools

Use this pattern when an LLM manages state by resending a complete array.

## Contract

1. Treat ordinary updates as non-destructive: compare the accepted prior snapshot with the proposed snapshot and reject missing identities.
2. Give every item a stable identity. If no explicit ID exists, require unique normalized content and treat rewording as destructive.
3. Separate destructive intent from normal progress with explicit operations such as `replace` and `clear`; require a human-readable reason when unfinished work is discarded.
4. Validate shape and transitions before mutating state. Return a cloned accepted snapshot in tool-result details.
5. Make completion observable in at least one successful snapshot before later clearing or replacement.

## Persistence

Rebuild state only from successful tool-result detail snapshots on the active session branch. Do not trust attempted assistant tool-call arguments: blocked, invalid, failed, or abandoned-branch calls are intent, not committed state. Re-run restoration after session start and tree navigation.

## Verification Checklist

- Ordinary status/order changes and additions succeed.
- Omission, rename, and direct unfinished clear fail without explicit destructive intent.
- A rejected transition leaves prior in-memory state unchanged.
- Duplicate identities fail.
- Failed/attempted calls never restore.
- Divergent branches restore their own snapshots.
- Empty and malformed history degrade to empty or the last valid state.
