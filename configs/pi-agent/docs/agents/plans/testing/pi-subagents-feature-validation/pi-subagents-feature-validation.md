# Pi Subagents Feature Validation

## Context and requirements

We will validate the active `pi-subagents` extension one feature at a time.

1. Test only one named feature per step.
2. State the expected result before acting.
3. Capture the observed tool/UI/state result and assign `PASS`, `FAIL`, or `BLOCKED`.
4. Stop on a failure and diagnose it before testing another feature.
5. Use minimal, deterministic test agents and clean them up after destructive/lifecycle tests.
6. Do not treat the existing bundled test suite as proof of live behavior; use it only as a final regression check after the isolated live tests.

No extension feature was exercised while preparing this inventory.

## Grounded feature inventory

The active package is `configs/pi-agent/packages/pi-subagents`, loaded from the global Pi package settings. Its entry point registers seven main-agent tools, `/subagents`, and the `alt+a` stop shortcut (`extensions/subagents/index.ts:84-90`, `:155-172`).

### Main-agent tools

- `subagent_spawn`: typed or ad-hoc, persistent or oneshot, optional initial task, ad-hoc model/thinking/tool overrides (`tools/main-agent.ts:21-88`).
- `subagent_send`: enqueue a task/follow-up without interrupting a running turn (`tools/main-agent.ts:90-120`).
- `subagent_steer`: inject guidance only into a currently streaming turn (`tools/main-agent.ts:122-143`).
- `subagent_await`: await explicit anchors or every open task, in `any` or `all` mode, with partial timeout results (`tools/main-agent.ts:145-200`).
- `subagent_cancel`: non-destructively abort running/queued work while retaining pending mail (`tools/main-agent.ts:203-222`).
- `subagent_retire`: destructive deregistration plus transcript archival (`tools/main-agent.ts:225-245`).
- `subagent_status`: roster/open-task inspection or one agent’s transcript tail (`tools/main-agent.ts:247-274`).

### Runtime and lifecycle features

- Persistent typed agents default to `<type>/main`; persistent addresses are get-or-create. Ad-hoc agents default to auto-named oneshots; persistent ad-hoc agents require an ID (`runtime/in-process.ts:186-217`).
- Spawn is asynchronous and records task envelope anchors (`runtime/in-process.ts:232-248`).
- The scheduler enforces the configured concurrency cap; default `maxConcurrent` is 4 (`runtime/in-process.ts:165`, `store/settings.ts:20-23`).
- One final report closes all open anchors drained for that agent; await also recognizes fatal-error and retired outcomes (`runtime/in-process.ts:421-479`).
- Oneshots auto-retire after a final report, preserving their archived session (`runtime/in-process.ts:738-742`).
- Persistent sessions reopen their latest Pi JSONL; subagents load no extensions, skills, templates, or themes (`runtime/in-process.ts:775-803`).
- The only subagent communication tool is `report`; coding tools are separately allowlisted (`tools/sub-agent.ts:22-57`, `runtime/in-process.ts:800-809`).
- Guarded coding tools route confirmation through pi-safety and state-tree/type-definition paths are hard-denied (`runtime/in-process.ts:166-170`, `:803-818`).
- Idle final reports wake the main agent with `followUp + triggerTurn`; mid-turn mail waits for settlement (`index.ts:43-50`, `:66-81`, `:267-275`).
- Subagents require a persisted host session and a single-process host lease (`index.ts:175-196`).

### Human UI features

- `/subagents`: picker, direct `<type>/<id>` viewer jump, or `stop` (`index.ts:155-166`).
- Picker: roster/archive view, cancel, confirmed retire, and stop-all (`tui/picker.ts:1-6`, `:153-202`).
- Viewer: live transcript/vitals, Enter to message, Alt+Enter to steer, Alt+J for next (`tui/viewer.ts:1-8`, `:129-157`).
- Live above-editor activity tree and `alt+a` stop brake (`tui/tree-widget.ts:1-15`, `:30-79`).
- Ambient status exposes running, waiting-for-confirmation, and unread-mail counts (`tui/widget.ts:1-10`, `:36-57`).

## Ordered isolated live-test checklist

Each numbered item is a separate test. Do not continue automatically after reporting its verdict.

1. **Extension availability and empty/base status**
   - Action: call `subagent_status` with no address.
   - Expected: valid roster/open-task response; no initialization or lease error.

2. **Persistent ad-hoc spawn without work**
   - Action: spawn `adhoc/feature-test` with `lifetime:persistent`, no task.
   - Expected: immediate `created:true`, state `dormant`, no open task.

3. **Detailed status is read-only**
   - Action: inspect `adhoc/feature-test` twice.
   - Expected: identity/vitals/session tail are returned and state/history do not change.

4. **Persistent get-or-create**
   - Action: spawn the same address and prompt again without a task.
   - Expected: `created:false`; existing agent/history remains intact.

5. **Send to a dormant agent**
   - Action: `subagent_send` a deterministic reporting task.
   - Expected: envelope anchor returned; dormant agent wakes; task appears in open tasks.

6. **Single-target explicit await**
   - Action: await the anchor from test 5.
   - Expected: terminal `completed` outcome with the correlated final report; anchor closes.

7. **Send while busy queues at the turn boundary**
   - Action: start a slow task, then send a second task while the agent is running.
   - Expected: second send reports held/queued, does not interrupt, and is processed afterward.

8. **Mid-turn steering**
   - Action: steer a deliberately slow running task.
   - Expected: `steered:true` and the correction is reflected in the final result; steering while dormant returns `false`.

9. **Running-turn cancellation**
   - Action: cancel a deliberately slow running task.
   - Expected: `cancelled:true`, agent becomes dormant, triggering mail remains pending/redeliverable, no false completion.

10. **Resume after cancellation**
    - Action: send follow-up mail to the cancelled agent.
    - Expected: pending work redelivers with the follow-up and the agent retains prior memory.

11. **Queued-turn cancellation**
    - Setup: occupy all scheduler slots, queue one extra agent, cancel only the queued agent.
    - Expected: it never starts streaming, becomes dormant, and its task remains pending.

12. **Await `any`**
    - Action: run fast and slow agents; await both in `any` mode.
    - Expected: one completed outcome for the fast agent and the slow target remains pending/joinable.

13. **Await `all` with omitted targets**
    - Action: create multiple open tasks and call await with no targets.
    - Expected: every current open anchor is joined; no unrelated mailbox item is consumed.

14. **Await timeout with partial results**
    - Action: await fast and slow tasks with a short timeout.
    - Expected: completed outcomes plus explicit pending targets; timed-out work remains joinable later.

15. **Fatal-error await outcome**
    - Action: give an agent a task designed to produce a genuine turn failure.
    - Expected: await resolves that target as `error`, not success or timeout, and its anchor closes.

16. **Typed definition discovery**
    - Setup: add one temporary project-local type definition.
    - Expected: typed spawn succeeds, defaults to `<type>/main` and persistent lifetime.

17. **Tolerant type parsing and validation**
    - Action: include one foreign frontmatter key, then separately test one malformed known key.
    - Expected: foreign key warns but loads; malformed known key blocks spawn with a clear error.

18. **Project trust and definition shadowing**
    - Action: compare trusted versus untrusted project-definition visibility/shadowing in controlled sessions.
    - Expected: project defs load and shadow only when trusted; global definitions remain authoritative otherwise.

19. **Model and thinking selection**
    - Action: spawn ad-hoc with explicit model/thinking, then test inherited defaults separately.
    - Expected: valid overrides apply; invalid model/thinking fails clearly without wedging the roster.

20. **Coding-tool allowlist**
    - Action: create an agent with `tools:[]`, then a read-only subset.
    - Expected: first has only `report`; second has exactly `report` plus its allowed coding tools.

21. **No nesting and no peer communication**
    - Action: ask a subagent to spawn or contact another agent.
    - Expected: no `subagent_*`/`team_*`/peer-mail tools are available; it can only report to main.

22. **Safety confirmation and waiting state**
    - Action: have an agent request a guarded but harmless bash/write operation; approve once and deny once.
    - Expected: pi-safety identifies the requesting address, status shows `waiting` during the prompt, approval executes, denial does not.

23. **Protected-state hard deny and fail-closed safety**
    - Action: attempt access to extension state/type-definition roots, then test without a safety claimant in an isolated process.
    - Expected: protected paths are denied before prompting; missing/failed safety claimant denies execution.

24. **Ad-hoc oneshot lifecycle**
    - Action: spawn an unnamed ad-hoc task and await it.
    - Expected: auto-generated `adhoc/tmp-*`, final report delivered, agent disappears from live roster, transcript remains archived.

25. **Persistent retirement**
    - Action: retire a finished persistent test agent, then send to its old address and retire again.
    - Expected: first retire archives/deregisters; later send bounces; repeated retire is harmless with no new archive.

26. **Idle auto-wake**
    - Action: end the main turn while an agent is still working.
    - Expected: its final report wakes the idle main agent exactly once and closes its open task only after delivery acceptance.

27. **Mid-turn wake deferral**
    - Action: let an agent finish while the main agent is still in an active turn.
    - Expected: report queues as a follow-up and does not interrupt the current turn.

28. **Concurrency cap and FIFO queueing**
    - Action: start more slow agents than the configured cap.
    - Expected: exactly the cap runs, extras queue, and queued work starts in arrival order as slots free.

29. **Status, activity tree, and ambient counts**
    - Action: observe dormant, running, queued, waiting, unread, and idle transitions.
    - Expected: tool/status data and the visible tree/status line agree; tree hides when no agent works.

30. **`/subagents` picker**
    - Action: exercise navigation, archive toggle, cancel, confirmed retire, and `S` stop-all.
    - Expected: roster updates live; destructive retire requires confirmation.

31. **Subagent viewer**
    - Action: open by picker and direct address; inspect transcript, Enter-message, Alt+Enter-steer, Alt+J-next, Esc-back.
    - Expected: viewer follows the documented behavior and direct human messages create transparent FYI mail to main.

32. **Global stop brake**
    - Action: run multiple agents, use `alt+a`, repeat with `/subagents stop`.
    - Expected: all working agents stop non-destructively, pending mail remains, dormant agents are unaffected.

33. **Reload/resume persistence**
    - Action: give typed and persistent ad-hoc agents memorable facts, reload/resume the same host session, ask follow-ups.
    - Expected: roster, constitutions, transcripts, vitals, and memory survive.

34. **Single-host lease**
    - Action: open the same persisted session in a second Pi process while the first owns it.
    - Expected: second process reports the owning PID and cannot control that fleet; ownership releases after shutdown.

35. **Unavailable non-persisted session**
    - Action: use an isolated `--no-session` Pi process.
    - Expected: every `subagent_*` tool fails cleanly with the persisted-session requirement.

36. **Coexistence with pi-teams**
    - Action: run one teams agent and one subagent concurrently.
    - Expected: separate tools/state/UI coexist, both safety channels work, and both wake paths deliver without loss.

37. **Shutdown and retention cleanup**
    - Action: finish the test fleet, retire persistent fixtures, quit cleanly, and inspect process/state hygiene.
    - Expected: no orphan sessions/processes, host lease released, only intended archives remain.

38. **Final automated regression**
    - Action: only after all isolated live tests, run `configs/pi-agent/packages/pi-subagents/test/e2e/run.sh`, then the pi-teams regression suite.
    - Expected: strict typecheck and all harnesses pass. This is corroboration, not a substitute for the live verdicts.

## Per-test result format

```text
Feature: <one checklist item>
Expected: <observable contract>
Action: <exact tool/UI action>
Observed: <tool result, state transition, UI, and relevant persisted evidence>
Verdict: PASS | FAIL | BLOCKED
Cleanup: <what was removed/retired/restored>
Next: stop and wait for approval
```

## Risks and controls

- The current worktree already contains unrelated modifications; tests must not overwrite or clean them.
- There are currently no global or project-local typed subagent definitions, so typed tests require a temporary fixture and explicit cleanup.
- Cancellation, retirement, project-trust, no-session, lease, and safety-provider tests can disturb the active session; run them only at their numbered point and announce the impact first.
- TUI behavior requires user observation; tool/state evidence alone cannot prove keybindings or rendering.
- A live model may not deterministically produce a fatal error or long-running state. If needed, use the existing scripted harness for only that one contract and label the result as harness evidence rather than live-model evidence.
