# Pi Teams SDK Compatibility And Validation

## Outcome

The current `pi-teams` extension passes its strict typecheck, all 11 end-to-end harnesses (114 checks), and a live step-by-step validation in Pi.

## Root Cause

After a Pi SDK update, live team agents could be registered and receive mail but never start a session. The runtime called:

```ts
resolveCliModel({ cliModel, modelRegistry })
```

The current SDK requires a canonical `ModelRuntime`:

```ts
resolveCliModel({ cliModel, modelRuntime })
```

The resulting pre-start exception (`getModels` on `undefined`) was emitted only as an internal runtime event. The agent returned to `dormant`, its assignment stayed unread for retry, and `team_await` timed out without exposing the cause.

The test harnesses had the same SDK drift: they used removed top-level `AuthStorage` and `ModelRegistry.inMemory` APIs.

## Implementation

- `extensions/teams/runtime/in-process.ts`
  - Creates current-SDK agent session services with `createAgentSessionServices`.
  - Reuses one canonical `ModelRuntime` across team-agent handles.
  - Mirrors public extension-registered provider configs from the main session's `ModelRegistry` facade.
  - Resolves model references with `resolveCliModel({ modelRuntime })`.
  - Creates sessions with `createAgentSessionFromServices`.
  - Sends an error envelope to main when handle construction fails, while keeping the original task pending for retry.
- `extensions/teams/core.ts`
  - Accepts an optional canonical `modelRuntime` instead of the removed `authStorage` option.
- `test/e2e/env.mjs`
  - Provides a current-SDK mock model-runtime helper.
- Runtime E2E phases were migrated from removed auth/registry factories.
- `phase2-runtime.mjs` now verifies that pre-start failures reach main and preserve the original assignment.

## Live Validation

The live pass verified:

- Type discovery and persistent spawning
- Detailed roster/transcript inspection
- Main-to-agent mail, dormant wake, and persistent reuse
- Steering and interruption
- Structured collection
- Await outcomes: `completed`, `attention`, `timeout`, and `retired`
- One-shot automatic retirement
- Peer delivery, peer questions/answers, peer mode controls, and bounce behavior
- Idle-main auto-wake and burst coalescing
- Pi Safety approval and denial in `max` mode
- Reload lease reacquisition, session persistence, and post-reload reuse

## Operational Findings

- Old queued assignments correlate a final report to the oldest pending assignment when several retries are delivered together. Use that original anchor when recovering from a fixed pre-start failure.
- Pi Safety results are meaningful only after confirming the active mode. In `off`, commands are intentionally auto-allowed; in `max`, live approval and denial were both audited correctly.
- A stale same-process Teams lease from an older runtime required one full Pi restart. A subsequent `/reload` reacquired the lease correctly and preserved agent state.

## Verification

```sh
configs/pi-agent/packages/pi-teams/test/e2e/run.sh
```

Result: strict typecheck clean; all 11 harnesses green; 114 checks passed.
