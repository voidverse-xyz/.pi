# Pi Agent Self-Review — pi-agents (2026-07-10)

Provenance: produced by the user's Pi coding-agent session DOGFOODING this extension
— it spawned six pi-reviewer subagents (adversarial/mail/runtime/sandbox/store/tui)
on the live extension. Relocated here verbatim from the package's stray docs/ tree.
Findings are being independently verified against HEAD and fixed; see git history.

# Subagent Extension Review

Date: 2026-07-10

## Scope

Reviewed `extensions/subagents/` across runtime/lifecycle, mail, sandbox,
persistence/configuration, type discovery, and TUI integration. The full E2E
suite was green before this review, so the findings below primarily identify
missing adversarial and race coverage.

## Confirmed high-severity findings

### 1. Interrupt/shutdown consumes the triggering mail

- `extensions/subagents/runtime/in-process.ts:968-1010`
- `session.abort()` commonly resolves with an assistant `stopReason: "aborted"`.
  `_mailTurn()` still calls `markDone()` before examining the failure/abort
  state, so the triggering envelope is removed instead of being re-delivered.
- This contradicts the `subagent_interrupt` contract. The live interrupt smoke
  test also ended with `unread: 0` and no re-delivery.
- Fix: decide whether the turn completed before `markDone`; explicit interrupt
  and shutdown should leave the envelope pending and suppress immediate retry.

### 2. Queued turns can start after the autonomy pool pauses

- `runtime/in-process.ts:848-934`
- `canStart()` is checked before awaiting a scheduler slot. Many waiters can
  pass the check, then start one-by-one after an earlier turn trips the pool.
- Fix: re-check/atomically consume the budget immediately after slot acquisition
  and before run ownership, mailbox consumption, or model execution.

### 3. The read-only/path sandbox has command-classification bypasses

- `sandbox/bash-guard.ts:119-124, 398-437, 457-470`
- Confirmed classifications incorrectly return `allow` for:
  - `git remote add evil /tmp/repo`
  - `git remote remove origin`
  - `git reflog expire --all`
  - `GIT_EXTERNAL_DIFF='touch /tmp/pwn' git diff`
  - `LESSOPEN='|touch /tmp/pwn %s' less README.md`
- Root causes: `git remote`/`git reflog` are treated as wholly read-only without
  checking their action, and arbitrary leading environment assignments are
  stripped even though they can add execution hooks.
- Fix: classify nested git actions; reject/escalate environment assignments
  unless each variable is explicitly proven harmless for the selected command.

### 4. Protected system paths can be changed through ancestors/directory destinations

- `sandbox/paths.ts:181-194`
- `sandbox/bash-guard.ts:490-543`
- The hard-denial check only detects a target equal to or below a protected
  prefix. Mutating an ancestor such as project `.pi` can delete/move the
  protected `.pi/subagents` definitions and settings.
- `cp`/`mv`/`ln`/`install` also check the supplied destination directory but not
  the effective `destination/basename(source)`, allowing a protected child or
  `denyPaths` child to be replaced through an allowed parent directory.
- Fix: account for ancestor-destructive operations and conservatively validate
  all possible effective destination paths.

### 5. Cross-process run ownership is check-then-write, not atomic

- `runtime/in-process.ts:836-898, 1393-1419`
- Two Pi processes can both observe no foreign owner and then overwrite the same
  `.run-owner.json`, allowing simultaneous sessions to append one agent JSONL.
- Fix: claim with an atomic exclusive create (`wx`) under a cross-process lock,
  validate/sweep stale owners, and only proceed after a successful claim.

### 6. Distinct cwd paths can share the same state root

- `store/layout.ts:47-49, 223-230`
- Confirmed: `cwdSlug('/a-b/c') === cwdSlug('/a/b-c')`.
- Registry, teams, mailboxes, archives, and persistent session memory can leak
  between colliding projects.
- Fix: append a digest of canonical cwd or persist/verify canonical cwd with a
  migration path.

### 7. Project-local types bypass Pi project-trust checks

- `typedefs/discover.ts:44-68`; runtime resolution at
  `runtime/in-process.ts:455-456`
- The global extension manually reads `<cwd>/.pi/subagents` and project files
  shadow global definitions, but it never checks `ctx.isProjectTrusted()`.
- Fix: disable project type definitions until the project is trusted; surface
  source/path/hash changes, especially when a project type shadows a global one.

## Confirmed medium-severity findings

### 8. Collect validation metadata is deleted before host delivery is durable

- `core.ts:338-376`; `mail/mailbox.ts:367-379`
- `takeCollectRequest()` removes the schema while composing the digest. A crash
  before the host appends it requeues the report but not its schema, so the only
  delivered copy has no validation verdict.
- Fix: use non-destructive lookup and delete only after verified host delivery.

### 9. The advertised schema subset has false verdicts

- `mail/collect.ts:53-101`
- Confirmed:
  - `{type:"object", additionalProperties:false}` accepts `{x:1}` when
    `properties` is absent.
  - object `const`/`enum` equality depends on property insertion order because
    it uses `JSON.stringify`.
  - unknown/malformed type values are treated as matches.
- Fix: recursively validate schemas and implement JSON-semantic deep equality.

### 10. A result field named `collectSchema` hides the result

- `mail/digest.ts:103-118`
- Any data object containing `collectSchema` is rendered as a request regardless
  of envelope type/direction. A legitimate report result is hidden and replaced
  with incorrect fulfillment instructions.
- Fix: identify requests by explicit envelope metadata, or at minimum require
  the main-to-agent request direction and message type.

### 11. Team names and persisted membership shapes are unsafe

- `store/teams.ts:30-92`; spawn input in `tools/main-agent.ts`
- Confirmed `team: "__proto__"` throws after the registry record is already
  committed. A malformed string membership value can make substring
  `.includes()` authorize peers.
- Fix: validate team names, use own-property/null-prototype maps, and deeply
  validate member arrays and addresses when reading.

### 12. Invalid settings reloads fail open

- `store/settings.ts:110-214`; `index.ts:478-490`
- A temporarily malformed settings file is treated as an empty layer, replacing
  restrictive live values with defaults and removing optional ceilings.
  Warnings are retained internally but not shown.
- Fix: retain the last-known-good layer on parse/read failures and surface the
  warning; only an intentional missing file should remove a layer.

### 13. Retirement and archive GC are non-transactional

- `runtime/in-process.ts:585-611`; `store/archive.ts:34-90`
- A crash between registry removal, team scrub, and archive move can resurrect
  old memory or preserve stale ACL membership on a later spawn. Concurrent GC
  can observe an archive before its retirement marker is written.
- Fix: per-address lifecycle lock plus a durable retirement journal/tombstone;
  coordinate GC and use non-recursive removal for supposedly empty type dirs.

### 14. Direct user input in the viewer does not reset autonomy

- `runtime/in-process.ts:526-543`; `tui/viewer.ts:384`
- D21 says user input resets the pool, but `sendAsUser()` does not reset/resume
  it. When paused, a real user message from the subagent viewer remains queued.
- Fix: give the user-only path an explicit autonomy reset before delivery; do
  not apply this to main-agent tool sends.

## Lower-priority issues

- `typedefs/discover.ts:71-75`: listing omits symlinked type definitions even
  though exact resolution/spawn follows them.
- `mail/mailbox.ts:90-110`: filename/body envelope-ID mismatch is not
  quarantined, causing endless re-delivery if state is corrupted.
- Envelope text and aggregate digest size are unbounded; a large report can
  overflow main context even though structured `data` is capped.
- Truncated collect data is not retrievable through a dedicated API; the digest
  can contain incomplete JSON while saying the full value is on disk.
- ULID ordering can move backward if the wall clock moves backward.

## Verification performed

- Full `test/e2e/run.sh`: typecheck and all ten harnesses passed.
- Focused pure reproductions confirmed cwd collision, sandbox allow decisions,
  team prototype crash, schema false verdicts, and `collectSchema` rendering
  collision.
- Live tests confirmed the interrupt path consumes its triggering task and the
  normal collect-rendering fix works after reload.

No extension source code was modified during this review.
