# Pi Subagents Defect Fixes

## Scope

Fixed the four defects found by the feature-validation run:

1. New `subagent_spawn` calls with an initial task never started.
2. Explicit/inherited model selection failed under the current Pi SDK.
3. `subagent_await` completed mail held for a later turn when an earlier same-agent task reported final.
4. The bundled strict/e2e suite used removed SDK auth/model APIs.

## Implementation

### SDK model-runtime migration

`pi-subagents` now follows the current SDK service pattern already used by `pi-teams`:

- `core.ts` and `runtime/in-process.ts` accept the canonical `modelRuntime` type from `CreateAgentSessionServicesOptions` instead of the removed root `AuthStorage` API.
- Agent handles are built through `createAgentSessionServices` and `createAgentSessionFromServices`.
- One model runtime is retained across subagent handles.
- Extension-registered provider configs exposed by the main session's `ModelRegistry` facade are mirrored into the subagent model runtime.
- `resolveCliModel` now receives `modelRuntime`.
- The e2e harness creates a current SDK model runtime plus `ModelRegistry` compatibility facade; runtime phase worlds are initialized asynchronously.

This restores spawn-with-task, inherited host-model selection, explicit model overrides, and the test harness.

### Exact per-turn terminal anchors

Terminal envelopes now persist `payload.terminalAnchors`, the exact main-task envelope IDs drained into that mail-turn snapshot.

- Final reports stamp anchors from `handle.trigger`.
- Fatal errors stamp only the anchors consumed by the failed turn.
- Await resolves and closes only targets listed on the matching terminal envelope.
- Auto-wake digest commit closes only those listed open tasks.
- Reports without the new field retain a correlation-ID fallback; old unscoped error envelopes retain their legacy close-all behavior.
- Retirement still closes every task for the retired address.

This preserves the valid "one final report completes several tasks drained together" behavior without completing mail that arrived while the turn was already running.

## Regression coverage

Added or updated coverage for:

- `terminalAnchors` envelope validation.
- Current SDK model-runtime harness initialization.
- Spawn-with-task, model selection, oneshot execution, and resume flows under the migrated harness.
- Multiple anchors deliberately parked and drained in one snapshot resolving to one report.
- A second task held during task A resolving only after its own task-B report, with distinct report IDs.
- Auto-wake commit closing report/error anchors precisely.

## Verification

Automated:

1. `configs/pi-agent/packages/pi-subagents/test/e2e/run.sh` — **PASS**, strict typecheck plus all 9 harnesses.
2. `configs/pi-agent/packages/pi-teams/test/e2e/run.sh` — **PASS**, strict typecheck plus all 11 harnesses.
3. `git diff --check -- configs/pi-agent/packages/pi-subagents` — **PASS**.

Live after `/reload`:

1. New ad-hoc oneshot with initial `task` returned `SPAWN-TASK-FIXED` and completed — **PASS**.
2. Valid `openai-codex/gpt-5.6-sol` override with `thinking: low` returned `MODEL-OVERRIDE-FIXED` — **PASS**.
3. Task B sent while task A was running returned `held`; one await returned distinct A and B reports with the correct anchors and IDs — **PASS**.
4. A live pi-teams oneshot returned `TEAMS-LIVE-FIXED` after reload — **PASS**.
5. Cleanup ended with zero live subagents and zero open tasks.

## Files changed

- `configs/pi-agent/packages/pi-subagents/extensions/subagents/core.ts`
- `configs/pi-agent/packages/pi-subagents/extensions/subagents/index.ts`
- `configs/pi-agent/packages/pi-subagents/extensions/subagents/mail/deliver.ts`
- `configs/pi-agent/packages/pi-subagents/extensions/subagents/mail/envelope.ts`
- `configs/pi-agent/packages/pi-subagents/extensions/subagents/runtime/in-process.ts`
- `configs/pi-agent/packages/pi-subagents/extensions/subagents/store/open-tasks.ts`
- `configs/pi-agent/packages/pi-subagents/test/e2e/env.mjs`
- `configs/pi-agent/packages/pi-subagents/test/e2e/harness.mjs`
- Runtime phase files under `configs/pi-agent/packages/pi-subagents/test/e2e/`
