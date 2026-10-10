# Choosing Pi Subagents, Teams, or Swarm

## Summary

Use the smallest coordination mechanism that fits the task:

- **Pi Subagents:** delegate a focused assignment; the main agent coordinates.
- **Pi Teams:** retain specialists for repeated collaboration, optionally with peer messaging.
- **Pi Swarm:** execute an approved, bounded objective with managed tasks, file claims, independent review, and recorded verification.
- **No delegation:** prefer the main agent for simple edits, quick lookups, or work where coordination would cost more than it saves.

This guide is for agents selecting a workflow in this Pi configuration. Package documentation and current tool contracts are authoritative; this guide does not grant execution, outbound, commit, or push permission.

## Comparison

| Dimension | Subagents | Teams | Swarm |
|---|---|---|---|
| Best fit | Focused independent assignments | Ongoing specialist collaboration | End-to-end bounded objectives |
| Coordination | Strict hub-and-spoke through main | Main coordination; optional peer messaging | Workers coordinate execution; main bridges owner decisions |
| Lifetime | One-shot or persistent | Persistent until explicitly retired | Persistent workers within a run; fresh contexts for a new objective |
| Completion | Worker reports back | Assignment ends; specialist remains available | Independent review and recorded verification determine completion |
| Relative overhead | Usually lowest | More coordination | Most governance and setup |

Persistence alone is not a reason to choose Teams: persistent Subagents also retain memory. Choose Teams when continuing specialist relationships and peer collaboration are useful. More agents do not automatically improve speed, quality, or cost.

## Pi Subagents: focused delegation

Choose Subagents when the assignment is clearly expressible as “do this and report back,” and workers do not need direct peer communication. The main agent synthesizes findings and resolves dependencies.

Examples:

- A scout locates authentication code while main investigates a bug.
- Independent reviewers assess security, performance, and test coverage.
- A worker runs tests while another inspects the implementation, without conflicting mutations.
- A persistent reviewer handles follow-ups, with communication routed through main.

Example user request:

> Use two subagents: one investigates failing tests, another reviews the relevant code. Report their findings before making changes.

Agent practice:

- Give each spawn a concise task-specific label and a bounded assignment.
- One-shot spawns require a non-empty initial task; the role prompt is not the task.
- Use persistent workers only when follow-ups justify retained context.
- Await the returned assignment anchor when findings are needed for the current answer. Timeout or cancellation is not completion.
- Subagents cannot spawn, inspect, or message peers. Route coordination through main.

Avoid Subagents for frequent direct negotiation between specialists; consider Teams instead.

## Pi Teams: continuing specialist collaboration

Choose Teams when named specialists should retain context across repeated assignments and may benefit from direct communication. Peer messaging is optional, not guaranteed to be enabled.

Examples:

- Backend and frontend specialists agree on an API contract.
- An implementer and reviewer work through several user-reviewed slices.
- A documentation specialist tracks evolving implementation decisions.
- A tester shares reproduction details directly with an implementer.

Example user request:

> Create persistent backend and frontend specialists and a reviewer. Let them coordinate the API contract, but bring architectural decisions to me.

Agent practice:

- Reuse stable type/ID addresses for continuing roles; separate instances need separate IDs.
- Define file ownership, responsibilities, escalation points, and whether peer messaging is appropriate.
- Final reports finish assignments but leave agents dormant with memory intact.
- Explicitly retire agents when no longer needed; retirement archives their memory.
- Await anchored reports when they are required for the current answer.

Teams do not automatically supply Swarm's managed task/file-claim and verified-completion workflow. Main must coordinate shared edits and verification. For a single independent review or lookup, prefer Subagents.

## Pi Swarm: managed objective execution

Choose Swarm when the objective has clear scope, acceptance criteria, and limits, and workers should carry it through implementation and independent review.

Examples:

- Implement endpoint pagination, client integration, and regression tests.
- Migrate a bounded group of modules to a new interface.
- Fix a reproducible bug and independently verify regression coverage.
- Complete a scoped refactor with explicit exclusions and request/time budgets.

Example user request:

> Use Swarm to implement pagination for the orders endpoint and UI. Preserve existing filters, add regression tests, require independent review, and limit the run to 30 minutes.

Agent practice:

- Prepare and explain the complete agreement before execution. Only a new owner reply of exactly `start` approves an ordinary pending proposal; the original request is not launch confirmation.
- Choose a bounded objective, explicit criteria, scope/exclusions, tools, and limits.
- Main acts as the owner interface, not the task dispatcher. Forward owner steering, handle actionable escalations and present results; let workers manage routine assignments and peer handoffs.
- For bounded implementation, consider one initial implementer; workers recruit an independent reviewer after candidate settlement rather than creating a large team or an unnecessary planning worker. Settled board transitions offer bounded task/review wakes without main relays.
- Workers request `swarm_finish` after independent task acceptance and criterion coverage. Runtime final verification produces the completion result; a request alone is not completion.
- Model selections must use the available catalog, be disclosed, and remain pinned to the approved settings. Recommend and obtain permission before changing models.
- Coordinate file claims and quiet verification windows; do not retry-loop behind peers retaining claims.
- Candidate reports are not completion. Require independent review and fresh recorded verification.
- Prefer event-driven `swarm_wait` over sleep/status polling. A timeout is not completion or settlement evidence.
- Pause/stop do not undo changes or prove interrupted operations settled. Restore attaches paused; continuation requires fresh approval. Recovery requires the documented evidence-bearing confirmation, not generic `start`.

Swarm preserves changes by default and does not automatically stash, reset, stage, commit, or push. Its safeguards are cooperative controls, not an OS sandbox; independent Safety policy remains authoritative. Native Windows end-to-end behavior is documented as unverified; Linux is the verified platform.

Avoid Swarm while the objective is ambiguous or the user wants to approve each design decision before implementation. Clarify the design first, or use Teams for continuing discussion.

## Decision checklist

1. Can main finish the work simply without delegation? Stay with main.
2. Is there one clear independent assignment, or independent parallel findings? Use Subagents.
3. Do specialists need repeated collaboration and potentially direct peer communication? Use Teams.
4. Is there an approved bounded objective requiring managed execution and verified completion? Use Swarm.

Across all mechanisms, preserve existing user work, minimize unnecessary context and worker count, prevent overlapping edits, and report verification limitations honestly. Delegation never expands the user's authorization.

## Sources and maintenance

Behavior checked against the repository package documentation when this guide was created:

- [Pi Subagents](../../../packages/pi-subagents/README.md)
- [Pi Teams](../../../packages/pi-teams/README.md)
- [Pi Swarm](../../../packages/pi-swarm/README.md)

Recheck these sources and current tool schemas when coordination, approval, lifetime, recovery, or platform support changes.
