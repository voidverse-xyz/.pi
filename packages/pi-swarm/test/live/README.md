# Bounded native trial

## Summary

Explicitly authorized, supervised synthetic CSV exercise through `SwarmHost` and
`createNativeRuntime`. Inactive by default; no extension activation or installation.
This is not a sandbox or a spending cap. The reviewer must remain a non-contributor.

## Usage

Requires managed Pi 1.0.4 SDK, Node 22.19+, Git and POSIX. From the package directory:

```sh
node test/live/trial.mjs # dry run, no SDK/configuration/authentication reads
node --experimental-import-meta-resolve --import ./test/sdk-register.mjs \
  test/live/trial.mjs --live --provider <approved-provider> \
  --model <approved-model> --thinking <approved-level>
```

Before `--live`, obtain scoped approval for the selected native provider to receive
synthetic files, task instructions, worker messages/history and tool results, including
service retention. The flags attest that approval; they do not collect it. The native
runtime uses existing Pi configuration/authentication by reference, with catalog network
refresh disabled; no credentials are copied into the fixture. No fallback model exists.
Capture the current host thinking level or obtain explicit approval for an override; do not
assume `off` is supported. Unsupported thinking fails before fixture creation or model dispatch.
Do not use private source, inherited project instructions, or unrelated provider configuration.

The harness prints a new neutral `/tmp/swarm-trial-*` location. It retains its Git project
and private runtime evidence under its own `agent/sessions/` tree, without a commit or automatic cleanup. Limits are fixed:
two identities, two active workers, five tasks, one failed/rejected attempt per task,
five minutes active wall-clock. No automatic continuation or allowance reset occurs.

The standalone host policy approves writes only to `csv.mjs` and `csv.test.mjs` and denies
all shell strings except exactly `node --test`. **That string alone is not safe:** generated
tests execute code. For every changed source fingerprint, execution waits for separate
source inspection. Inspect both files in `project/`, including imports and side effects;
deny any networking, subprocess, environment/filesystem access, dynamic import/eval, or
non-fixture module. Parser imports are forbidden; tests may import only `node:test`,
`node:assert/strict`, and `./csv.mjs`. After inspection, copy ONLY the fingerprint from
`pending-check.json` into `approved-check.json` in the printed control directory:

```json
{"fingerprint":"<inspected source hash>"}
```

The control directory is outside the worker checkout; workers cannot approve themselves.
Approval applies only while both source files retain that hash. Inspect promptly: waiting
counts against the existing five-minute budget and safety requests expire after two minutes.
No approval file means no generated code executes. The fixture is a cooperative boundary,
not protection against a malicious model, external writers or escaped processes.

The harness retains `result.json`, journal and native histories locally. Results count
persisted assistant responses/tokens, not necessarily physical HTTP calls; cost remains
unknown. Never publish raw provider errors/history/configuration. Independently rerun the
reviewed tests and inspect durable candidate/review/final evidence before claiming success.
An incomplete run stops without retry. Retain unsettled evidence for investigation.

Reporting waits for settlement before reading usage. Completed/failed controllers are already
terminal: cleanup must not dispatch another stop event. Summary generation and cleanup are
separate phases; a reporting failure still attempts settled-host disposal in `finally`.
Errors expose only a phase (`setup`, `execution`, `reporting`, `cleanup`) and sanitized code,
not native exception text. Incomplete settlement retains ownership and exits unsuccessfully.

The first approved synthetic trial durably completed with independent review and a passing
final check, but its original reporting cleanup requested stop after automatic controller
closure and failed before writing `result.json`. That result was recovered read-only from
the retained journal/history; the repair was tested offline, not with a second live run.
This historical result does not validate the current migration; use the package README for current offline coverage and limitations.
