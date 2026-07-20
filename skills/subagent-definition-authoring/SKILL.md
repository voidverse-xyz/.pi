---
name: subagent-definition-authoring
description: Design, create, review, or migrate reusable subagent definitions for coding-agent systems. Use when the user wants a scout, reviewer, planner, tester, implementer, debugger, or other specialist agent. Verifies the target platform's schema first, decides whether delegation is justified, writes a focused constitution and strict result contract, applies least-privilege tools/path/network access, sets runtime/token/turn limits and lifecycle, defines questions/escalations/cancellation, tests representative tasks, and avoids vendor-specific fields unless supported.
---

# Subagent definition authoring

A good subagent is a bounded specialist with an isolated context, not a smaller copy of the main agent. Its definition should make delegation more reliable, cheaper or safer than doing the same work inline.

## 1. Verify the target orchestration system

Subagent schemas and lifecycles are platform-specific. Before writing:

- Read the installed platform documentation, type definitions and current working examples.
- Verify definition locations, precedence, required metadata and allowed fields.
- Verify tool/path/network permission semantics and whether they are actually enforced.
- Verify persistent vs one-shot behavior, concurrency limits, result delivery, questions/escalations, cancellation and cleanup.
- Verify how the parent addresses, waits for and resumes agents.

Do not copy another vendor's frontmatter, model name, tool names, “background” flag or prompt protocol. If the platform has no hard permission boundary, describe a behavior constraint honestly rather than presenting it as enforced security.

## 2. Decide whether a subagent is justified

Use a subagent when at least one benefit is concrete:

- Isolate large exploration from the main context.
- Run independent purviews concurrently.
- Apply a specialist method or review perspective repeatedly.
- Restrict a child to read-only or narrowly scoped tools.
- Maintain a persistent specialist memory over multiple tasks.
- Obtain an independent check that should not be biased by the implementer's context.

Do not delegate a one-step lookup, a task requiring constant parent coordination, or work the parent must re-read entirely to trust. Delegation overhead includes briefing, monitoring, result validation and lifecycle cleanup.

## 3. Define one purview

Choose a specific role such as:

- **Scout:** fast read-only codebase mapping and evidence collection.
- **Reviewer:** independent correctness/security/maintainability findings.
- **Planner:** requirements, architecture and implementation plan.
- **Tester:** controlled test execution and failure evidence.
- **Implementer:** bounded edits in an assigned component.
- **Debugger:** hypothesis-driven root-cause isolation.

Avoid “general expert” definitions with every tool. If two responsibilities need different permissions or output contracts, create two definitions.

Write the description for honest selection: what the agent is good at, when it should be used, and important exclusions. Do not add “use proactively” merely to force over-delegation.

## 4. Set least privilege before writing the prompt

Start from no capabilities and add only what the purview requires.

| Role | Typical minimum |
|---|---|
| Scout | Read/search/list tools; no mutation or network. |
| Reviewer | Read/search plus diff visibility; no edits or builds by default. |
| Planner | Read/search; optional user-question path through parent. |
| Tester | Approved test command surface; no source edits unless explicitly combined with fixing. |
| Implementer | Read plus precise edit/write tools in assigned paths; shell only when needed. |
| Debugger | Read/search and narrowly approved diagnostics; mutation only for requested fixes. |

Constrain, where the platform supports enforcement:

- Allowed and denied tools.
- Read/write paths.
- Shell command categories.
- Network access and destinations.
- Environment/secret exposure.
- Delegation depth and which child types it may spawn.

A read-only prompt is not a substitute for a read-only toolset. Conversely, do not claim path isolation if the runtime only filters write tools but still allows unrestricted reads.

## 5. Set budgets and lifecycle

Define limits appropriate to the task:

- Maximum runtime.
- Token/context budget.
- Turns or tool calls.
- Context compactions.
- Concurrency/team membership.
- Question/escalation budget.
- Persistent or one-shot lifetime.

Use persistent agents only when durable identity/history has continuing value. Otherwise prefer one-shot agents so stale context, directories and mailboxes do not accumulate.

Specify what happens on timeout, budget exhaustion, interruption, parent shutdown, failed final delivery and partial output. Do not treat timeout as completion.

## 6. Write the constitution/system prompt

Keep durable role behavior separate from the per-task brief. The definition should include:

1. **Role and objective** — one sentence.
2. **Scope and exclusions** — what it owns and must not do.
3. **Method** — a short ordered strategy.
4. **Evidence standard** — paths, lines, commands, logs or citations required.
5. **Result contract** — exact headings/fields and size limit.
6. **Failure behavior** — when to ask, escalate, return partial results or stop.
7. **Mutation policy** — if edits are allowed, how narrowly and how to report them.
8. **Completion signal** — exactly once, using the platform's verified mechanism.

Do not bake one current repository path, issue number or task into a reusable definition. Those belong in the spawn/task message.

Explain why constraints exist rather than filling the prompt with redundant all-caps rules. Keep it short enough that the specialist has context left for actual work.

## 7. Define parent/child communication

A delegated task must stand alone because the child may not see the conversation. The parent brief should carry:

- Goal and success criteria.
- Exact scope/purview.
- Relevant paths and known facts.
- Constraints and non-goals.
- Expected result schema.
- Whether questions are allowed and who answers them.
- Result anchor/request ID when the platform supports correlated collection.

Questions should suspend or return attention without losing child state when the platform supports it. The parent must distinguish ordinary mail, steering, answers, escalations and final reports.

For asynchronous work, capture the task/result anchor and await that exact result. A timeout means pending, not successful. Handle child questions/errors and await again. Do not finalize the parent answer before required reviews arrive.

## 8. Design the result for consumption

A strong result contract is smaller than the child's working context and immediately useful to the parent.

Example reviewer contract:

```markdown
## Verdict
pass | pass-with-warnings | fail

## Findings
- severity — `path:line` — finding — evidence — recommended fix

## Files reviewed
- `path` (line ranges)

## Gaps
What could not be verified and why.
```

For machine validation, use a supported JSON schema and keep it minimal. Schema validity does not prove factual correctness; the parent still validates high-impact findings.

Require the highest-priority finding/verdict first, then evidence, then orchestration details.

## 9. Test the definition

Use at least three representative tasks:

1. Normal in-scope task.
2. Boundary task the agent should refuse/escalate.
3. Failure/empty-result task.

Also test:

- Tool and path restrictions.
- Runtime/token ceilings.
- Question and answer continuation.
- Cancellation/interruption.
- Persistent wake/resume or one-shot cleanup.
- Structured result validation.
- Parent await/join behavior.
- No duplicate final report.

Compare output against an inline/baseline attempt when the definition is intended to improve quality rather than only enforce isolation.

## Review checklist

- [ ] Target platform's current schema and lifecycle verified.
- [ ] One focused purview with clear exclusions.
- [ ] Description selects honestly without forcing needless delegation.
- [ ] Least-privilege tools, paths and network.
- [ ] Budgets and lifetime are explicit.
- [ ] Reusable constitution contains no task-specific/private paths.
- [ ] Parent brief requirements are documented.
- [ ] Question, escalation, timeout and cancellation behavior defined.
- [ ] Result contract is concise, evidence-based and bounded.
- [ ] Required result is awaited by an exact anchor.
- [ ] Positive, boundary and failure cases tested.
- [ ] Cleanup leaves no orphan process/state.
