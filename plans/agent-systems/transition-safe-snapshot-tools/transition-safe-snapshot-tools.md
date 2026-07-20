# Transition-safe snapshot tools

Use this pattern when an LLM-managed tool updates state by resending a complete array or object snapshot.

## Contract

1. Treat ordinary updates as non-destructive: compare the accepted prior snapshot with the proposed snapshot and reject missing identities.
2. Give every item a stable identity. If no explicit id exists, require unique normalized content and treat rewording as destructive.
3. Separate destructive intent from normal progress with explicit operations such as `replace`, `remove`, and `clear`; require a human-readable reason when unfinished work is discarded.
4. Validate shape and transitions before mutating state. Return a cloned accepted snapshot in tool-result details.
5. Make completion observable in at least one successful snapshot before later clearing or replacement.

## Persistence

Rebuild state only from successful committed tool-result snapshots on the active branch/session. Do not trust attempted tool-call arguments: blocked, invalid, failed, or abandoned-branch calls are intent, not committed state.

## Verification checklist

- Ordinary status/order changes and additions succeed.
- Omission, rename, and direct unfinished clear fail without explicit destructive intent.
- A rejected transition leaves prior in-memory state unchanged.
- Duplicate identities fail.
- Failed or attempted calls never restore.
- Divergent branches restore their own snapshots.
- Empty and malformed history degrade to empty or the last valid state.
