# Main-agent GitHub issue maintenance

## Summary

The explicitly invoked `github-issue-maintenance` skill keeps the active main
agent in charge of GitHub state and authorization. It does not create another
main agent or an `issue-maintainer` type. Ordinary issue fixes and discussion of
the skill do not activate the workflow.

## Sources of truth

- [Maintenance workflow](../../../../../../../skills/github-issue-maintenance/SKILL.md)
  — invocation, run gates, queue selection, durable claims, review, publication,
  and retirement policy.
- [Pi runtime adapter](../../../../../../../skills/github-issue-maintenance/references/pi-runtime.md)
  — persistent pair identity, owning-session continuity, exact assignment anchors,
  partial establishment, and verified retirement.
- [Worker definition](../../../../../../../subagents/worker.md) and
  [reviewer definition](../../../../../../../subagents/reviewer.md)
  — production role contracts and configured specialist models. Active
  project overrides must be inspected rather than assumed absent.
- [Evaluation scenarios](../../../../../../../skills/github-issue-maintenance/evals/evals.json)
  — isolated, no-side-effect prompts for activation, lifecycle, and failure checks.

## Integration rules

- Each pass processes at most one issue per repository, oldest eligible first.
  Exactly one of `discuss`, `improve`, and `fix` is required. Additional eligibility
  labels are explicit run configuration; `agent-ready` is not an implicit filter.
- The main agent handles discussion and issue improvement. Only a durably claimed
  `fix` issue receives one persistent worker/reviewer pair per open epoch. Its
  implementation uses a dedicated isolated worktree from the resolved base,
  reused without resetting for repairs and same-epoch PR follow-up.
- Main-agent model choice is unchanged; specialist model pins live only in their
  definitions. Neither the skill nor these notes override them.
- Coordination uses ordinary Pi Subagents, not Pi Teams or peer messaging. Its
  scope survives owning-session resume, not `/new`, forks, or unrelated sessions.
- Review and publication are separate anchored assignments. Review cannot be
  bypassed; commits, pushes, and PR publication each require authorization.
- Retirement policy is selected for the run. Previously granted authorization
  remains usable within its recorded scope, but copying the skill is not consent.
  Automatic retirement requires verified closure, idle specialists, complete
  assignment evidence, and verified success for both bound retirements.
- Private ledgers, session identities, agent addresses, and worktree paths never
  enter public GitHub comments. The public claim marker contains only its defined
  public-safe maintainer ID and issue number.

Read the linked workflow and adapter rather than duplicating their state machine
or model names here. Changes to selection, identity, invocation, or lifecycle must
update the evaluation scenarios alongside the authoritative instructions.
