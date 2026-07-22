---
name: plan
description: Research a task and produce a decision-complete implementation plan without carrying out the implementation. Invoke explicitly with /skill:plan, or use the Pi /plan mode wrapper.
disable-model-invocation: true
---

# Plan

Research and design the requested change without implementing it.

When the host says Plan mode is active, remain in Plan mode until the host explicitly changes modes or turns restricted modes off. User intent, imperative wording, or a request to implement does not exit Plan mode; treat such requests as requests to plan the implementation. When this skill is invoked directly without host-managed Plan mode, apply it to the current planning task only, and allow a later user message to request implementation.

## Procedure

When host-managed Plan mode selects a supplemental skill tagged `plan-template: true`, follow that one template together with these base boundaries. Do not combine multiple supplemental templates.

1. **Ground in the environment first.** Inspect the actual project, relevant instructions, entry points, types, tests, configuration, and prior art before designing a solution.
2. **Resolve discoverable facts yourself.** Do not ask the user questions that targeted read-only exploration can answer.
3. **Clarify consequential choices.** Use `ask_user` only for missing intent, preferences, or tradeoffs that materially change the design. Offer meaningful options and recommend a default.
4. **Choose one approach.** Reuse existing project patterns and commit to a recommended design rather than leaving implementation decisions to the executor.
5. **Delegate research only when it helps.** In host-managed Plan mode, subagents may research independent questions, but they must be fresh ad-hoc one-shot workers limited to `read`, `grep`, `find`, and `ls`. Keep synthesis and all plan-file saving with the main agent.
6. **Make the plan decision-complete.** Cover behavior, interfaces, state and lifecycle, failure cases, compatibility, and verification where they matter.

## Planning boundaries

- Do not edit, write, delete, format, generate, migrate, install, or otherwise modify project files.
- In host-managed Plan mode, the sole project-file exception is saving the complete final Markdown plan through the host-provided `save_plan` tool to its user-authorized path. Do not use any other tool or command to save it.
- When this skill is invoked directly without host-managed Plan mode, do not write a plan file; return the plan in chat.
- Use only read-only exploration and non-mutating checks. Plan-mode subagents are held to the same boundary and may not receive shell or mutation tools.
- Do not run commands that may carry out the proposed implementation.
- Do not confuse planning with an execution-progress checklist.
- Do not ask whether to proceed after presenting the plan.

## Final response

If a selected supplemental Plan template defines a required output structure, that structure replaces the default below. Preserve these base safety and save boundaries, but do not try to combine two incompatible section orders.

Otherwise, return a concise, human- and agent-executable plan using this structure:

### Summary

State the chosen approach and intended result.

### Implementation

List ordered changes grouped by subsystem or behavior. Name files only where doing so prevents ambiguity.

### Interfaces and behavior

Describe important types, APIs, commands, persistence, lifecycle, and failure semantics. Omit this section when none change.

### Test plan

List concrete tests and acceptance scenarios.

### Assumptions

Record defaults chosen and any constraints the implementer must preserve.

If revising an earlier plan, produce a complete replacement rather than a partial patch to the old plan.

When host-managed Plan mode provides `save_plan`, save that complete document before the final response and report the saved project-relative path.
