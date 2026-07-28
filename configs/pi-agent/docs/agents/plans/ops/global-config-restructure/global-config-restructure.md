# Global Pi configuration repository restructure

## Context and confirmed requirements

The repository will become a directly cloneable Pi global configuration: cloning its root to `~/.pi/agent` must activate the reviewed extensions, themes, skills, keybindings, teams, and subagent definitions without host-specific paths.

1. Restructure the entire repository root, not only `configs/pi-agent/`.
2. Support direct cloning into `~/.pi/agent`; do not require global symlinks.
3. Keep reusable non-Pi materials such as Codex, MCP, plans, and configuration sources in the repository even though Pi ignores them.
4. Track portable source configuration only; credentials, sessions, trust, caches, managed installs, logs, databases, and extension-owned mutable state must remain ignored.
5. Preserve unmatched or inactive Pi material locally under `tmp/pi-global-config-migration/unmatched-pi/`, remove it from the cloneable tracked tree, and report every quarantined source path.
6. Verify the result from an isolated temporary Pi agent directory before changing the live global directory.

## Grounded findings

- Pi's global settings file is `~/.pi/agent/settings.json`, while `.pi/settings.json` is project-local (`@earendil-works/pi-coding-agent/README.md:280-287`).
- Sessions and managed package installs are runtime state under `~/.pi/agent/sessions`, `npm`, and `git`, so they must not be tracked (`@earendil-works/pi-coding-agent/README.md:238,431`).
- Paths in global `settings.json` resolve relative to `~/.pi/agent`, which permits portable `./configs/pi-agent/packages/...` entries (`@earendil-works/pi-coding-agent/docs/settings.md:234`).
- Pi auto-discovers global skills, prompts, extensions, and themes from their documented global resource directories (`@earendil-works/pi-coding-agent/README.md:335-400`).
- The active custom runtimes share the global type library at `subagents/`; Pi Teams keeps separate settings and runtime state but resolves the same definitions as Pi Subagents.
- The current Git tree has no tracked symlinks and no tracked live credential/runtime files. The active settings use 25 absolute package paths; these must become relative.

## Design and migration manifest

### Root Pi resources

- Case-rename `Skills/` to `skills/` through an intermediate path so the change is represented correctly with `core.ignorecase=true`.
- Case-rename `Subagents/` to `subagents/` through an intermediate path.
- Move the two test-only definitions from `subagents/` to `configs/pi-agent/packages/pi-subagents/test/fixtures/type-definitions/`.
- Keep one canonical production type-definition library in `subagents/`; both runtimes discover it and protect it from linked-file mutation.
- Move `configs/pi-agent/.pi/agent/keybindings.json` to root `keybindings.json`.
- Add root `settings.json` containing only the selected theme and 25 relative package paths.
- Keep reusable Markdown procedures in nested `procedures/<domain>/` directories. Reserve top-level `procedures/*.js` files for executable saved `pi-procedure` scripts; the loader ignores the nested Markdown procedures.

### Skill activation and Plan mode

Root `skills/` becomes Pi's canonical global skill library. Remove the package manifest's special `Skills/plan` path and the extension's hard-coded tagged-skill discovery hook. Plan mode will continue selecting the base `plan` skill and tagged templates from Pi's already-loaded skill descriptors.

### Unmatched Pi quarantine

Move these tracked sources into the ignored local quarantine, retaining their relative paths below `tmp/pi-global-config-migration/unmatched-pi/`:

- legacy source `Configs/PiAgent/.pi/` after extracting `keybindings.json`
- legacy source `Configs/PiAgent/packages/_archive/`
- legacy source `Configs/Archive/PiAgent/`
- legacy source `Configs/Archive/codex-pi/`

The temporary quarantine is deliberately not committed. The tracked result records deletions, while the local files remain available for inspection and recovery until the user removes the temporary directory.

### Portable and private boundaries

Root `.gitignore` will exclude credentials, provider model overrides, sessions, trust decisions, managed packages/binaries, caches, logs, databases, extension settings/state, environment files, private keys, editor artifacts, and the migration quarantine. Reviewed `settings.json`, `keybindings.json`, source packages, skills, and definitions remain tracked.

### Documentation

- Add a root README explaining direct clone, safe cutover, restoration of ignored local state, permissions, and verification.
- Update `AGENTS.md`, PiAgent manifests, package READMEs, and active implementation notes for the new root resources and relative activation.
- Keep project-specific implementation records under `configs/pi-agent/docs/agents/` and a sanitized reusable procedure under `plans/`.

## Safety and lifecycle

- No live `~/.pi/agent` mutation occurs during the repository migration.
- Moves are Git-visible and recoverable; unmatched Pi artifacts are copied by move into an ignored quarantine rather than deleted.
- Runtime state is restored only after cloning and remains ignored. `auth.json` must be mode `0600`; the agent root and private runtime directories should be owner-only where practical.
- If isolated Pi loading fails, repair the repository before any live cutover. The existing live directory remains the rollback source.

## Risks and dispositions

1. Activating all root skills increases the skill catalog compared with the old Plan-only package registration. This is intentional for sharing; verify collision and validation warnings in the isolated smoke test.
2. Tracked `settings.json` may acquire Pi-written preference fields during normal use. Review every diff and never commit host-specific values.
3. Markdown procedures and executable saved JavaScript procedures share the `procedures/` root. This is safe because the loader scans only top-level `.js` files and ignores the nested Markdown procedure directories.
4. Package sources remain nested under `configs/pi-agent/packages/` to preserve existing tests and project documentation. Relative settings remove host dependence without a wider source-tree rewrite.

## Verification

1. Confirm no tracked credential/runtime path or symlink exists.
2. Confirm every package path in `settings.json` is relative, exists, and does not reference an archive.
3. Confirm `.gitignore` rejects representative credentials, sessions, caches, managed installs, state, logs, databases, environment files, and quarantine paths.
4. Run JSON/frontmatter validation and all affected package tests, including `pi-plan`, `pi-subagents`, and `pi-teams`.
5. Create an isolated temporary agent directory from tracked files only, run Pi offline against it, and confirm package, skill, theme, keybinding, subagent, and team discovery without credential access.
6. Confirm the quarantine contains every source path listed above and no active source path.
7. Run `git diff --check`, inspect `git status`, and report moves, deletions, warnings, and tests without committing or pushing.
