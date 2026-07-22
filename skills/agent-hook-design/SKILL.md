---
name: agent-hook-design
description: Design, implement, review, or migrate lifecycle hooks for coding agents, IDE agents, CLIs, and agent harnesses. Use when the user wants automation before/after tool calls, prompt submission, file edits, shell/network actions, subagent lifecycle, compaction, session start/stop, or agent completion. Requires reading the target runtime's current hook contracts instead of guessing event names or JSON fields, and covers deterministic-vs-model hooks, fail-open/closed policy, strict I/O, timeouts, reentrancy, privacy, testing, and safe rollout.
---

# Agent hook design

Hooks run code or policy at agent lifecycle boundaries. They can improve safety and automation, but they also sit on critical paths where one stale schema, slow process, recursive action, or malformed response can block the entire agent.

## 1. Verify the target platform first

Hook APIs are not portable. Before designing:

- Identify the exact agent runtime, version and run mode.
- Read its installed documentation, types and working examples completely.
- Verify supported event names, payload fields, permitted responses, exit-code behavior, timeout defaults, ordering, concurrency and reload semantics.
- Determine whether the hook runs in the project directory, user config directory, a sandbox, container, remote worker or parent process.

Never copy another vendor's event name or response field into the target runtime from memory. If the current contract cannot be verified, write a design note with assumptions rather than installing a hook that may silently fail or block work.

## 2. Confirm the hook's contract

Extract or ask only what is missing:

| Decision | Questions |
|---|---|
| Scope | Project, user, workspace, session, or one tool? |
| Trigger | Which verified event is the narrowest correct boundary? |
| Purpose | Observe, audit, validate, block, rewrite, inject context, or schedule follow-up? |
| Policy | What is allowed, denied, transformed, or reported? |
| Failure | Fail open, fail closed, warn, retry, or disable? |
| Latency | Maximum acceptable time on this critical path? |
| Privacy | Which input/output fields may be logged or sent elsewhere? |
| Ownership | Who maintains the script and how is it disabled/recovered? |

Prefer the narrowest event and scope that satisfy the requirement. A global pre-tool hook is unnecessary when the policy concerns only shell commands.

## 3. Decide whether a hook is the right artifact

Use a hook for event-driven enforcement or automation that must run whether or not the model remembers it.

Choose something else when appropriate:

- Persistent guidance or conventions → agent instructions/rules.
- Reusable optional expertise → skill.
- A multi-stage human-approved procedure → procedure.
- A typed capability the model should call intentionally → dedicated tool.
- Isolation or independent review → subagent.

Do not use a hook merely to restate prose the agent already receives, and do not use prose alone for a hard security boundary.

## 4. Choose deterministic or model-based evaluation

### Deterministic command hook

Prefer code when the decision must be reproducible, auditable, low latency, testable, or security-sensitive:

- Path allow/deny checks.
- Command classification.
- Schema validation.
- Redaction.
- Formatting after successful edits.
- Exact policy gates.

### Model/prompt hook

Use model judgment only when the policy is genuinely semantic and false positives/negatives are acceptable. Keep the prompt bounded, return a strict schema, set a short timeout, and define what happens when the model is unavailable.

Never make a remote model call from a hook without explicit authorization for that destination and payload. Do not put secrets, full prompts, source files or tool output into an external evaluation by default.

## 5. Design strict input and output

Treat hook input as untrusted versioned data:

- Parse once and reject malformed shapes deliberately.
- Validate the event discriminator before reading event-specific fields.
- Use allowlisted fields and actions; ignore or reject unknown output fields according to the platform contract.
- Keep stdout reserved for the exact machine-readable response when the runtime expects JSON. Send diagnostics to the supported log channel or stderr only if allowed.
- Emit one response, not mixed logs plus JSON.
- Avoid shell interpolation of payload values; pass data through stdin, argv arrays, or environment variables with clear size limits.
- Cap input/output size and truncate diagnostics without cutting JSON.

Do not echo sensitive input back into logs or user-facing errors. Report field names and classifications, not secret values.

## 6. Set failure policy intentionally

Fail-open and fail-closed are risk decisions, not defaults to inherit blindly.

- **Fail closed** when executing despite hook failure could cause the exact harm the hook exists to prevent, and a safe recovery/override path exists.
- **Fail open with warning** when hook availability is less important than keeping local development usable.
- **Disable/quarantine** after repeated invalid output or timeouts when the platform supports it.

Document behavior for timeout, crash, invalid JSON, unsupported event version, missing dependency, permission denial, cancellation and shutdown.

A fail-closed hook must include a tested recovery path that does not require the broken hook to approve its own repair.

## 7. Control side effects and recursion

Hooks may run concurrently or trigger actions that fire more hooks.

- Make observation hooks idempotent.
- Key state by event/tool/session ID rather than a single global variable.
- Use atomic writes and per-target locking for file mutations.
- Prevent recursive activation with a supported event marker or narrowly scoped guard—not an unbounded global disable flag.
- Stage on intent and finalize only on a verified success event when the lifecycle separates before/after phases.
- Clean abandoned pending state on cancellation, timeout, session end and restart.
- Do not mutate user files from a read/audit hook.

If ordering among multiple hooks matters, verify whether the runtime guarantees it. Otherwise design them to commute or combine them into one owner.

## 8. Keep the execution environment minimal

- Use a direct executable/script path and argv rather than a shell string when supported.
- Verify every helper binary and runtime exists in the actual hook environment.
- Avoid network access and heavyweight process startup on hot paths.
- Use the least filesystem, tool and network permissions possible.
- Resolve relative paths from the platform's documented working directory.
- Keep project hooks project-relative and portable; keep machine-local values out of committed config.
- Set explicit timeouts below the platform's outer timeout.

Do not add dependencies just for a small parser when the runtime's standard library is sufficient.

## 9. Implement with a reversible rollout

1. Preserve unrelated existing hooks and configuration.
2. Add one event with the simplest verified filter.
3. Validate config syntax and script executability.
4. Run the hook directly with fixture JSON before involving the agent.
5. Trigger one real allow case and one real deny/error case.
6. Verify timeout, invalid input and missing dependency behavior.
7. Inspect logs for secret leakage and duplicate execution.
8. Reload/restart only as documented.
9. Record how to disable or remove the hook safely.
10. Tighten matchers only after the base hook reliably fires.

Do not delete or replace the old mechanism until the new hook passes its real lifecycle tests and the user approves migration cleanup.

## Verification matrix

| Case | Expected evidence |
|---|---|
| Event does not match | Hook skipped with no side effects. |
| Valid allow input | One valid allow/no-op response. |
| Valid deny input | Action blocked or escalated with a concise safe reason. |
| Rewrite/input mutation | Only supported fields change; downstream receives the verified shape. |
| Hook crash | Documented fail-open/closed behavior occurs. |
| Timeout | Process is stopped and policy is applied once. |
| Invalid/multiple output | Runtime rejects or handles it as designed. |
| Parallel events | State and output remain isolated by event ID. |
| Recursive trigger | Guard prevents loops without disabling unrelated hooks. |
| Reload/restart | Registration and durable state recover correctly. |
| Shutdown/cancel | No orphan process, lock or pending record remains. |

## Final deliverable

Report:

- Target runtime/version and verified source contracts.
- Scope, event and filtering.
- Input/output schema.
- Deterministic/model choice and why.
- Failure/timeout/reentrancy policy.
- Files created or changed.
- Test cases and results.
- Disable/rollback procedure.
- Any unverified behavior that still requires a real runtime check.
