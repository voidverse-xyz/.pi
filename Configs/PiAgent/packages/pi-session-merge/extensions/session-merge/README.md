# Session Merge

`session-merge` adds `/session-merge` (alias: `/merge`), a synthesis merge for
Pi session branches. Both names invoke the same command.

It does not rewrite or delete the source session tree. Instead, it selects two
or more branch leaves, asks the current model to synthesize the shared base and
branch deltas, then creates a new session with that merge context as a visible
custom message.

## Usage

```text
/session-merge
/session-merge <entry-id-or-label> <entry-id-or-label> [...]
/merge          (alias — identical to /session-merge, args included)
```

With one argument, `/session-merge <entry>` merges the current leaf with that entry.
Arguments can be exact entry IDs, unique ID prefixes, or exact single-token
labels. Use the interactive picker for labels with spaces.

## Flow

1. Pick two to six source branches.
2. Generate and edit the merge context.
3. Choose whether to draft a kickoff prompt, run it immediately, or only create
   the merged session.
4. Optionally label unlabeled source leaves as `merged-YYYY-MM-DD`.

The new session records the previous session as `parentSession` and stores source
entry IDs in `session-merge` metadata.
