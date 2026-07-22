# Pi Procedure Feature Test Results

## Scope

Validate `pi-procedure` one feature group at a time. Stop after each group to report the result; fix and re-run that group before continuing if a defect appears.

## Test order

1. Extension loading and public surface registration
2. Inline procedure and single-agent execution
3. Script metadata, phases, logs, and `args`
4. Parallel fan-out, concurrency limits, and failure isolation
5. Pipeline chaining and dropped-item behavior
6. Structured output and schema validation
7. Per-agent model, thinking, and tool options
8. Deterministic script sandbox and prohibited globals
9. Journaling and agent transcripts
10. Resume cache replay and divergence
11. Saved procedure resolution, precedence, and trust gates
12. `/procedures` command and completions
13. Stop brake through `/procedures stop` and `alt+w`
14. Tool sandbox, protected paths, and safety confirmations
15. Live progress widget and session lifecycle cleanup
16. One-run-at-a-time enforcement and error reporting
17. Configuration handling and full regression run

## Results

### 1. Extension loading and public surface registration — PASS

Command:

```sh
cd configs/pi-agent/packages/pi-procedure
node test/e2e/loadcheck.mjs
```

Verified:

- The extension loads through Jiti without an initialization error.
- It registers the `procedure` tool.
- It registers the `/procedures` command.
- It registers the `alt+w` shortcut.
- It registers `session_start` and `session_shutdown` handlers.
- The tool rejects requests that provide zero or multiple procedure sources.

Result: 2 checks passed. No defect found; no code change required.

### 2. Inline procedure and single-agent execution — PASS

Ran the registered `procedure` tool with an inline script containing a required metadata header, one phase, and one plain-text `agent()` call.

Acceptance checks:

- The tool returned `status: "completed"`.
- The procedure result preserved the subagent's exact `PROCEDURE_SINGLE_AGENT_OK` response.
- The summary contained exactly one agent with sequence `0`, the requested label, the active phase, and status `"ok"`.
- The run produced a resumable run identifier and run directory.

Result: the live inline procedure completed successfully. No defect found; no code change required.

### 3. Script metadata, phases, logs, and `args` — PASS

Commands and checks:

```sh
cd configs/pi-agent/packages/pi-procedure
node --test extensions/procedure/script/meta.test.ts
```

- All 7 metadata extraction and validation tests passed.
- Valid metadata supports string phases and `{title, detail}` phase objects.
- Invalid, impure, malformed, or duplicated metadata is rejected.
- Metadata removal preserves script line positions.

A live zero-agent procedure then exercised metadata, `phase()`, `log()`, and supplied `args`:

- The tool returned `status: "completed"`.
- The result contained the supplied `PROCEDURE_ARGS_OK` marker.
- The summary preserved both phases in order.
- The summary preserved both log messages in order.
- A procedure with no `agent()` calls completed normally.

Result: metadata, phase tracking, narrator logs, and procedure arguments behaved as documented. No defect found; no code change required.

### 4. Parallel fan-out, concurrency limits, and failure isolation — PASS

Commands:

```sh
cd configs/pi-agent/packages/pi-procedure
node --test --test-name-pattern='parallel' extensions/procedure/script/semantics.test.ts
node --test extensions/procedure/runner/scheduler.test.ts
node test/e2e/phase1-live-run.mjs
```

Verified:

- All 4 isolated `parallel()` behavior tests passed.
- Branch failures become `null` without discarding successful siblings.
- Stop signals propagate instead of being converted to `null`.
- Invalid parallel inputs are rejected.
- Parallel thunks start in deterministic array order.
- Both scheduler tests passed, including FIFO queue draining and safe double release.
- The live-SDK fan-out harness completed five agents while staying at or below its concurrency cap of two.
- Fan-out outputs were preserved in source order and threaded into the downstream agent.

Result: 10 checks passed across unit, scheduler, and live-SDK coverage. No defect found; no code change required.

### 5. Pipeline chaining and dropped-item behavior — PASS

Commands and checks:

```sh
cd configs/pi-agent/packages/pi-procedure
node --test --test-name-pattern='pipeline' extensions/procedure/script/semantics.test.ts
```

- All 3 isolated pipeline tests passed.
- Each stage received `(previousResult, originalItem, index)` correctly.
- A thrown stage dropped only its own item to `null` and skipped its remaining stages.
- Independent item chains progressed without a global stage barrier.
- Stop signals propagated to the procedure instead of being converted to `null`.

A live procedure piped two items through a synchronous stage and then through separate `agent()` calls:

- The tool returned `status: "completed"`.
- Results were returned in input order as `A:A:0:DONE` and `B:B:1:DONE`.
- Both live agents received the correct original item and index in their labels and prompts.

Result: pipeline semantics and live agent chaining behaved as documented. No defect found; no code change required.

### 6. Structured output and schema validation — PASS AFTER FIX

Checks:

```sh
cd configs/pi-agent/packages/pi-procedure
node --test extensions/procedure/schema/validate.test.ts
node test/e2e/phase2-schema.mjs
node test/e2e/loadcheck.mjs
```

- All 3 schema-validator tests passed.
- The live-SDK schema harness passed 4 checks covering invalid output, in-turn retry, valid capture, and exhausted retries inside `parallel()`.
- A registered-tool live procedure returned the required structured object with the expected `const` and integer values.
- The extension still loaded and registered all public surfaces after the fix.

Defect found:

- Invalid `structured_output` values returned an object containing `isError: true`. Pi determines tool execution errors from thrown exceptions, so that returned field did not mark the tool result as an error.

Fix:

- `createStructuredOutputTool()` now throws a descriptive error for invalid values. Pi converts it into a real error result, and the subagent can correct the value in-turn.
- The live-SDK schema harness now explicitly asserts that invalid structured output throws and leaves the output slot unset.

Verification note: strict TypeScript checking was attempted but the compiler is not installed locally. No dependency was downloaded. Runtime loading and the focused schema suites passed.

### 7. Per-agent model, thinking, and tool options — PASS

Command:

```sh
cd configs/pi-agent/packages/pi-procedure
node test/e2e/phase1-live-run.mjs
```

The live-SDK harness now includes focused option coverage:

- A real `AgentSession` completed with an explicit `mock/mock-1` model, `thinking: "off"`, and a `read`-only tool allowlist.
- An unknown model failed before any provider request.
- An unknown tool name failed before any provider request.
- Invalid option branches became `null` under `parallel()` while the procedure itself completed.

Result: all 6 phase-one checks passed, including the two new option checks. No production defect found; regression coverage was added.

### 8. Deterministic script sandbox and prohibited globals — PASS

Command:

```sh
cd configs/pi-agent/packages/pi-procedure
node --test extensions/procedure/script/compile.test.ts
```

- All 5 compiler and sandbox tests passed.
- `Date.now()`, zero-argument `Date`, and `Math.random()` were blocked with deterministic-resume guidance.
- `require`, `process`, `setTimeout`, and `fetch` were unavailable.
- Deterministic `Date` construction with an argument and ordinary `Math` functions remained usable.
- Script syntax errors preserved original source line numbers.

A registered-tool negative check using `Date.now()` returned `status: "failed"` with the documented deterministic-resume error and did not start an agent.

Result: the script sandbox blocked nondeterministic and host globals as designed. No defect found.

### 9. Journaling and per-agent transcripts — PASS

```sh
cd configs/pi-agent/packages/pi-procedure
node --test extensions/procedure/journal/journal.test.ts extensions/procedure/journal/layout.test.ts
```

All 10 journal and layout tests passed. Coverage includes stable call hashing, corrupt-line tolerance, output sidecars and hydration, replay-cache ordering, safe run IDs, and layout path validation. The earlier live-SDK fan-out check also confirmed that every completed agent created a session transcript. No defect found.

### 10. Resume replay and divergence — PASS

```sh
cd configs/pi-agent/packages/pi-procedure
node test/e2e/phase3-resume.mjs
```

All 3 live-SDK resume checks passed: the original run made three model calls, an identical resume made none and marked every agent cached, and a changed middle prompt replayed only the unchanged prefix before running the remaining calls live. A registered-tool resume of the earlier single-agent smoke run also returned the same result with agent status `"cached"`. No defect found.

### 11. Saved procedure resolution, precedence, and trust gates — PASS

```sh
cd configs/pi-agent/packages/pi-procedure
node --test extensions/procedure/library/resolve.test.ts
```

All 3 library tests passed. Project procedures shadowed global procedures only when the project was trusted; global entries resurfaced otherwise. Invalid saved metadata remained visible, missing names reported available procedures, unsafe names were rejected, and absolute or project-relative `.js` script paths resolved correctly. No defect found.

### 12. `/procedures` command and completions — PASS

The extension load harness now creates an isolated saved project procedure and verifies command behavior. `/procedures` listed it with origin and description, `/procedures <name>` showed its phase metadata, prefix completion returned its name, and a missing name produced an error notification. The expanded load harness passed all 3 checks. No production defect found; regression coverage was added.

### 13. Stop brake and resumability — PASS

The live-SDK stop harness halted an in-flight slow agent, returned `status: "stopped"`, journaled only the completed agent, and then resumed successfully with the completed prefix cached. Registration of both `/procedures stop` and `alt+w` was already covered by the load harness. No defect found.

### 14. Tool sandbox and safety confirmations — PASS

```sh
cd configs/pi-agent/packages/pi-procedure
node test/e2e/phase4-stop-sandbox.mjs
node --test extensions/procedure/sandbox/safety-bridge.test.ts
```

The live-SDK harness hard-denied a bash command referencing a protected procedure directory and failed closed on an unapproved write without creating the target. Three added safety-bridge tests confirmed unclaimed requests fail closed, a synchronous pi-safety claimant receives and may approve the exact request, and provider failures become denials. No production defect found; safety bridge regression coverage was added.

### 15. Progress widget and session lifecycle cleanup — PASS AFTER FIX

```sh
cd configs/pi-agent/packages/pi-procedure
node --test extensions/procedure/tui/tree-widget.test.ts
node test/e2e/loadcheck.mjs
```

Defect found: widget refresh deduplicated solely on rendered tree lines. If a later run had identical visible tree content but a different run ID, refresh returned early and left the status row showing the previous run ID.

Initial fix: widget content and status text received independent deduplication keys. Interactive follow-up later showed that the generic procedure footer status competed with the shared directory/Git status presentation, so the footer producer was removed entirely. Procedure progress now lives only in the above-editor widget, which is the intended stable placement.

### 16. One-run enforcement and error reporting — PASS AFTER FIX

Defect found: top-level procedure input errors, active-run conflicts, and source-resolution failures returned an object containing `isError: true`. As with the structured-output defect, Pi only marks execution errors when the tool throws, so these failures appeared as successful tool executions at the runtime boundary.

Fix: the procedure tool now throws for invalid source selection, concurrent-run conflicts, and source-resolution/create errors. The obsolete returned-error helper was removed. The load harness now asserts thrown errors for zero/multiple sources, a pre-existing active run, and source-resolution failure. All load and schema checks passed after the fix.

### 17. Configuration handling and full regression — PASS WITH TYPECHECK CAVEAT

The load harness now verifies `maxConcurrent` behavior: default `4`, valid custom values, clamping to `1..64`, and fallback on fractional or malformed input.

Final command:

```sh
cd configs/pi-agent/packages/pi-procedure
SKIP_TYPECHECK=1 ./test/e2e/run.sh
```

Final result:

- 52 unit tests passed.
- 6 live fan-out and agent-option checks passed.
- 4 structured-output checks passed.
- 3 resume checks passed.
- 3 stop and sandbox checks passed.
- 5 extension load, configuration, error, and command checks passed.
- Total automated checks in the final suite: 73 passed, 0 failed.

A test-harness reporting defect was also fixed: when `SKIP_TYPECHECK=1` is used, the final summary now says `typecheck skipped` instead of falsely claiming typecheck passed.

Caveat: strict TypeScript checking was not run because no TypeScript compiler is installed locally, and dependencies were not downloaded. All runtime, Jiti-load, unit, and live-SDK checks passed.

## Final defect summary

1. Invalid structured output returned `isError: true` instead of throwing, so Pi did not mark it as an execution error. Fixed and regression-tested.
2. Top-level procedure input, active-run, and source-resolution failures used the same ineffective returned-error pattern. Fixed and regression-tested.
3. The TUI procedure footer status could become stale and competed with the shared directory/Git status presentation. The redundant footer producer was removed; progress is shown only in the above-editor widget.
4. The regression runner falsely reported a skipped typecheck as passed. Fixed.

All 17 feature groups pass after these fixes, subject to the strict-typecheck caveat above.

## Interactive follow-up: `/procedures` appeared to do nothing

Runtime reproduction through Pi RPC confirmed that `/procedures` was registered and executed, but its TUI output used only `ctx.ui.notify()`. With no saved procedures, the command emitted a transient informational notification, which could be missed or obscured by the customized status UI.

Fix:

- TUI invocations now append a durable, rendered `procedure-command-output` session entry for list, detail, and error results.
- Non-TUI modes retain `ctx.ui.notify()` and the RPC extension-UI protocol.
- The load harness now verifies entry-renderer registration and durable TUI command output.

The full runtime suite still passes: 73 checks passed, 0 failed; strict typecheck remains skipped because no compiler is installed.

## Interactive follow-up: bottom widget padding

Added one visually blank row after the active procedure tree so the widget does not sit directly against the editor. Pi discards empty or whitespace-only `Text` rows, so the widget uses a zero-width-space sentinel that renders as a blank padded line. The focused widget suite now passes 6 checks, and the 5 extension load checks remain green.

## Interactive follow-up: stable placement above directory/Git status

The procedure extension also published a generic `setStatus("procedure", ...)` value. The shared status-line extension treated it as a footer extension status, causing the procedure label to compete visually with the directory/Git presentation. The redundant footer status was removed. Procedure progress is now shown exclusively in the above-editor tree widget, with the new bottom padding.

A subsequent live check showed excessive vertical movement because current-tool sublines appeared only while an agent was active. Multiline detail was retained, but every agent now always owns exactly two rows. Inactive rows show stable state detail such as `Complete`, `Replayed from cache`, or `Waiting for a concurrency slot`; active rows replace only the second row's text without changing widget height.

A temporary `/procedures preview` toggle provided a persistent static widget for visual inspection without relying on fast subagents. Interactive validation confirmed the final placement, stable multiline layout, and bottom padding look correct. The temporary preview surface was then removed, leaving only the production `/procedures`, `/procedures <name>`, and `/procedures stop` behaviors. The focused widget suite passes 7 checks and the extension load suite passes 5 checks.
