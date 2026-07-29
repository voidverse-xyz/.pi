# Shared subagent definition library

## Outcome

Pi Subagents and Pi Teams now resolve typed agent definitions from the same canonical locations:

- global: `~/.pi/agent/subagents/<type>.md`
- trusted project: `<project>/.pi/subagents/<type>.md`

The root `subagents/` directory is therefore the only tracked production definition library. Its shared inventory includes `planner.md`, `reviewer.md`, `scout.md`, and `worker.md`; Pi Teams continues to discover the planner and scout there. The former root `teams/` copies and `agent/teams` compatibility shim were removed.

## Boundaries

Only definition discovery is shared. Pi Teams retains its independent behavior and storage:

- global settings: `~/.pi/agent/teams.json`
- project settings: `<project>/.pi/teams.json`
- session-scoped runtime state: the existing `sessions/<project>/teams/<session-id>/` tree

Pi Teams continues to parse its `peers` field. Pi Subagents tolerates Teams-only frontmatter keys as warnings, so a single definition can configure Teams without preventing Subagents use.

## Migration behavior

Legacy `~/.pi/agent/teams/*.md` and `<project>/.pi/teams/*.md` libraries are intentionally not discovered. This avoids split-brain precedence and ensures edits have one source of truth. Move any remaining definitions into the corresponding `subagents/` directory before reloading Pi.

Both runtimes continue rejecting symlinked or multiply hard-linked definition files and protect the shared definition directories from worker mutation.

## Verification

The Pi Teams data-layer harness asserts the shared global/project paths, preserves `teams.json` settings paths, verifies trusted project shadowing, and confirms legacy Teams definition directories are ignored. Sandbox harnesses verify that workers cannot modify the shared definition library.
