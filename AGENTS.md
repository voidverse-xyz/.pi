# Agent Instructions

Cross-project defaults for agents working on this machine.

## Instruction Precedence

Project-local guidance may override these defaults only for repository conventions such as style,
commands, architecture, and target branches. Global privacy and outbound-content rules,
preservation of user work, commit and push authorization, and destructive-operation restrictions
remain authoritative unless the user directly overrides them in the current conversation.

Before editing a repository, read its root `AGENTS.md` and project-local `.agents/README.md` when
present, then every applicable nested `AGENTS.md` from the root through the target file's parent.
Consult the global `readable-code` skill for non-trivial implementation or refactoring unless more
specific project guidance takes precedence.

## Progressive Discovery

For investigation and lookup tasks, minimize search scope and cost.

- Start from the conversation context and strongest available clues. Inspect the most likely target
  directly before discovering alternatives.
- Search progressively: exact file or symbol, then the nearest directory, then the relevant package,
  and the entire repository only when narrower searches fail.
- Prefer bounded searches and exclude dependencies, generated output, caches, version-control
  metadata, and unrelated worktrees unless they are relevant.
- Do not launch multiple speculative broad scans in parallel. Stop once there is enough evidence for
  the next action.
- If the scope cannot be narrowed efficiently, ask a focused question. Repository-wide discovery is
  appropriate first only for explicit inventories, audits, or cross-cutting investigations.

## Public And Outbound Content

Treat anything written outside the local working context as potentially public and long-lived.
Before writing PR descriptions, commit messages, issue bodies, review comments, docs, or content
sent to an external service:

- Do not name ignored, redacted, local-only, or environment files or describe what was excluded.
- Do not include home paths, private network addresses, unrelated projects, secrets, tokens,
  credentials, personal contact details, or account identifiers.
- Keep local-only details in chat with me, not in public artifacts.
- Do not put my personal email or contact details into commands, headers, code, config, logs,
  telemetry, User-Agent strings, or external requests. Use a neutral placeholder such as
  `noreply@example.com`, or omit the field.

## Git And GitHub

- Derive the base and target branches from project instructions, the remote default, and established
  repository practice. Ask only when those sources leave the choice ambiguous.
- Inspect Git status before editing and preserve pre-existing user work. Never stash, discard,
  restore, unstage, or commit it.
- Use an isolated worktree when the user requests one, relevant paths already contain unrelated
  changes, parallel or high-risk work benefits from isolation, or project instructions require it.
  Otherwise, work in the current checkout. Follow project-local worktree placement rules. When none
  exists and the user has not specified another destination, use the repository's `./.worktrees/`
  directory. Before creating a worktree there, ensure `/.worktrees/` is covered by the repository's
  `.gitignore` and verify it with `git check-ignore -q .worktrees/`. If verification fails, do not
  create the worktree there until the ignore boundary is handled safely and verified again. Follow
  the global `using-git-worktrees` skill whenever a worktree is appropriate.
- Use the `gh` CLI for GitHub operations.
- Match the repository's recent commit subject style.
- Commit or push only when I ask.
- Do not amend, force-push, skip hooks, or use destructive Git commands unless I explicitly ask for
  that exact operation.
- After a multi-line commit, verify the stored message with `git log -1 --format=%B`.
- Do not add agent attribution, session trailers, generated-by footers, internal model details, or
  tool runtime details to commits, PRs, issues, or review comments.

## Pi Configuration Repository

When the current repository is this portable Pi configuration, read `README.md` and
`configs/pi-agent/MANIFEST.md` before changing its layout or active resources. Then read the
relevant package README, project documentation, and nearest nested `AGENTS.md` for the area involved.
Do this automatically; do not wait for the user to request documentation. Do not load
repository-specific documentation for unrelated project work.

- Keep the root `AGENTS.md` filename uppercase; Pi loads it as global guidance.
- Root `settings.json`, `keybindings.json`, `skills/`, and `subagents/` are active global resources.
- `configs/pi-agent/packages/` is the source for enabled local Pi packages.
- When the user asks about a skill, procedure, MCP definition, or subagent, check this repository's
  `skills/`, `procedures/`, `mcp/`, and `subagents/` directories before other global or installed
  locations.
- Keep shared materials project- and host-agnostic. Keep machine-local credentials, sessions, logs,
  caches, and runtime databases out of the tracked tree.
- Root `subagents/` is the shared source of truth for Pi Subagents and Pi Teams definitions; do not
  create a separate definition library for teams.
- After changing Pi resources, run the repository validator and use `/reload` or restart Pi.

## Reusable Artifacts

Create or update a reusable plan, skill, procedure, subagent, MCP definition, plugin pattern, or
setup guide only when the user requests it, the artifact is an explicit deliverable, or the task is
specifically maintaining the reusable library. Do not create reusable copies as a side effect of
ordinary implementation work.

Reusable artifacts must be project- and host-agnostic. Replace project names, home paths, hosts,
accounts, credentials, private URLs, and environment-specific state with neutral placeholders.
Store the result in the repository's established location for that artifact type.

## Project Agent Documentation

Follow a project's existing agent-documentation structure. Do not create `.agents/`, modify a root
`AGENTS.md`, or write plans, notes, memories, or setup records merely because code was changed.
Create durable project agent material only when the user requests it or when it is an explicit task
deliverable.

When a project has no convention and an inert project-local documentation artifact is requested,
use lowercase hyphen-case under `.agents/docs/<type>/<domain>/<artifact>/<artifact>.md`, where
`<type>` is `plans`, `skills`, `procedures`, `subagents`, `mcp`, `notes`, or `memories`. Keep
project-specific material inside that project and exclude secrets, credentials, private paths,
personal details, and generated logs.

Keep `.agents/README.md` as a short, always-read overview and documentation router. Link directly
to detailed documents, state when each one should be read, and keep detail out of the README. Start
each detailed document with a brief `Summary`, followed by `Details`; read the summary first and
continue into the details only when relevant. Avoid chains of indexes.

Do not use that documentation layout for active resources. Verify the target runtime's discovery
contract first. In Pi, project skills use `.agents/skills/<skill-name>/SKILL.md`, project subagent
definitions use `.pi/subagents/<type>.md`, and executable saved procedures use
`.pi/procedures/<name>.js`.

## Working Style

- If something I ask for is technically wrong or impossible, say so and propose a workable
  approach.
- Use multiline syntax for the active shell: Bash heredocs in Bash and PowerShell here-strings in
  PowerShell. For multiline GitHub CLI bodies, use `--body-file -` and read the object back to
  verify what was stored.
- When delegated review findings are expected in the current response, await the anchored report;
  do not claim completion after timeout or cancellation. Put the verdict and findings before
  orchestration or cleanup details.
- When giving me app or server URLs in chat, use this machine's LAN IP instead of `localhost`,
  because I often access local services from other devices.
- When giving me an app URL for a project with any kind of login, include working demo credentials
  when available: email, password, and role. Source them from seed/demo data or fixtures. If they
  require a seed step that may not have run, say so and offer to run it.
