# Portable Pi global configuration

This repository is designed to be cloned as the portable Pi configuration tree:

```text
~/.pi
```

Pi's effective global agent directory is still `~/.pi/agent`; the tracked
`agent/` shims expose the repository's settings, keybindings, context, skills,
package sources, shared subagent definitions, and procedure library from that
location. Runtime state and credentials under `agent/` remain ignored.

The repository can also be cloned directly to `~/.pi/agent`; in that layout the
root files are Pi's effective agent config and the nested `agent/` shims are
dormant.

It combines portable Pi configuration with reusable agent materials and the
source of the local Pi packages enabled by `settings.json`.

## Layout

```text
<repository-root>/
├── AGENTS.md                 # Global agent instructions and documentation router
├── settings.json             # Portable settings; relative package paths
├── keybindings.json          # Global keybindings
├── skills/                   # Auto-discovered global Pi skills
├── subagents/                # Definitions shared by Pi Subagents and Pi Teams
├── configs/pi-agent/packages/ # Active local Pi packages
├── configs/pi-agent/docs/     # Package-specific plans and notes
├── plans/                    # Reusable plans and procedures
├── procedures/                # Reusable Markdown procedures
├── agent/                    # Compatibility shims when repo is cloned as ~/.pi
├── codex/                    # Codex configuration sources
├── mcp/                      # Reusable MCP definitions and notes
└── scripts/                  # Configuration validation
```

Pi ignores the extra reusable-material trees unless a package or setting refers
to them. Root `procedures/*.js` is reserved for executable saved `pi-procedure`
scripts; reusable Markdown procedures live in nested `procedures/<domain>/`
directories, which the procedure loader ignores.

## Repository guidance

This README is the source of truth for repository-specific layout and package
behavior. The automatically loaded root `AGENTS.md` tells agents to read it when
a task concerns this repository, so users do not need to request documentation
loading explicitly. Package-specific work must also follow the relevant package
README, project documentation, and nearest nested `AGENTS.md`.

The repository combines three roles:

- `settings.json`, `keybindings.json`, `skills/`, and `subagents/` provide the
  active portable Pi configuration.
- `configs/pi-agent/packages/` contains the local Pi packages enabled by relative
  paths from root `settings.json`.
- `codex/`, `configs/`, `mcp/`, `plans/`, `procedures/`, `skills/`, and
  `subagents/` hold reusable, project-agnostic materials.

Keep repository-owned directory names in lowercase hyphen-case. Preserve the
published casing of vendored assets and external specifications. Keep
host-specific tool configuration under `configs/` or `codex/configs/`; never
commit authentication data, session logs, caches, local history, runtime
databases, or other machine-local state.

`subagents/` is the single source of truth for production definitions shared by
Pi Subagents and Pi Teams. Do not create a separate root `teams/` definition
library. Local Codex plugin sources belong under
`codex/plugins/plugins/<plugin-name>/`, and marketplace-backed plugins use
`codex/plugins/marketplace.json`.

### Codex layout

- `codex/configs/` contains portable Codex configuration sources.
- `codex/plugins/marketplace.json` contains workspace marketplace metadata.
- `codex/plugins/plugins/<plugin-name>/` contains local plugin sources.

### PiAgent behavior

`configs/pi-agent/packages/` is the source of truth for active package-backed Pi
extensions. Root `settings.json` enables them with portable relative paths, and
root `skills/` is the canonical global skill library.

- **Modes:** `pi-plan` provides unrestricted Off plus restricted Discuss, Plan,
  and Quick modes through `/discuss`, `/plan`, `/quick`, and the `Shift+Tab`
  cycle. Quick keeps concise read-only chat; Discuss adds normal-length read-only
  discussion; Plan uses tagged planning skills and an authorized `save_plan`
  path. Plan-mode workers are fresh read-only one-shot Pi Subagents. The shared
  base instructions live in `skills/plan/`.
- **MCP:** `pi-mcp-client` loads machine-local `mcp.json` stdio server
  definitions with a minimal environment. Calls confirm by default, large
  catalogs use `mcp_search_tools`, and session shutdown owns process cleanup.
  Remote HTTP and unsupported MCP capabilities are intentionally out of scope.
- **Codex helpers:** `pi-codex-web-search` and `pi-codex-image-generation` use
  short-lived Codex clients and the existing ChatGPT login. Image generation
  uses an ephemeral image-only thread, accepts explicit source images, and
  confines output writes to the current working directory.
- **Timers:** `pi-timers` provides main-agent-only in-process recurring timers.
  Ticks coalesce while the agent is busy, and timers disappear on cancellation,
  reload, session replacement, or process exit. `/timers` and `Alt+R` expose
  list/cancel controls.
- **Sessions:** `pi-clear`, `pi-sessions`, and `pi-prune` provide `/clear`,
  `/sessions`, and lifecycle-safe session replacement/removal helpers.
- **Safety:** `pi-safety` gates agent-originated `bash` calls by category through
  `/safety off|on|max`, with local privacy-preserving audit state. It does not
  gate user-entered `!` commands.
- **Status UI:** `pi-git-status`, `pi-model-thinking`, `pi-tool-monitor`, and
  `pi-status-line` publish Git state, model/thinking, active tools, context,
  usage, and cost into the shared above-editor/footer UI. `/tools` opens the
  tool monitor and can abort the whole turn through `ctx.abort()`.
- **Subagents and procedures:** `pi-subagents` owns the main-agent worker tools
  and live tree. `pi-procedure` runs deterministic one-shot-agent orchestration
  scripts and exposes `/procedures`; its tree can be expanded with `Alt+E` and
  stopped with `Alt+W`.
- **Teams and merging:** `pi-teams` adds persistent team agents and optional peer
  messaging. `pi-merge` synthesizes selected session branches into a new session
  while leaving source branches intact.
- **User notices and turn statistics:** `pi-notify-user` renders structured
  end-of-turn notices with optional urgent toasts. `pi-turn-stats` emits a
  compact TUI-only notice after the agent truly settles; it does not alter the
  prompt or add model work.
- **Change tracking:** `pi-changes` records the main agent's successful
  `edit`/`write` touches with first-touch baselines. `/changes` provides
  git-independent diffs, file browsing, isolated read-only questions, and
  precise per-file undo where a safe baseline exists. Bash-made changes are out
  of scope.
- **Theme and keys:** `configs/pi-agent/packages/void-agent/themes/` contains the
  tracked theme family. Root `settings.json` selects the active theme, and root
  `keybindings.json` assigns thinking/model cycling while reserving `Shift+Tab`
  for `pi-plan`.

Mutable extension settings and all session/runtime state remain ignored. Run
`/reload` or restart Pi after changing a package, skill, subagent definition,
keybinding, or theme.

## Fresh installation

Back up an existing Pi directory before replacing it. Do not copy its settings
file over this repository's portable settings.

Preferred whole-tree install:

```bash
mv ~/.pi ~/.pi.backup
git clone <repository-url> ~/.pi
chmod 700 ~/.pi ~/.pi/agent
node ~/.pi/scripts/validate-global-config.mjs
```

Agent-dir-only install:

```bash
mv ~/.pi/agent ~/.pi/agent.backup
git clone <repository-url> ~/.pi/agent
chmod 700 ~/.pi/agent
node ~/.pi/agent/scripts/validate-global-config.mjs
```

Authenticate with `/login`. When migrating an existing installation, restore
only the machine-local state you intentionally preserved in the private backup;
keep it outside Git and retain its restrictive permissions.

Start Pi and run `/reload` after resource changes. The tested baseline is Pi
`0.83.0`; package features may also require Git, a Nerd Font, or the external
tools named in their package READMEs.

## Existing-machine cutover

1. Stop Pi processes.
2. Make a private backup of the complete existing `~/.pi/agent` directory.
3. Preserve required machine-local state privately.
4. Clone this repository to an empty `~/.pi/agent`.
5. Restore only the private state needed on the destination; keep the portable
   tracked configuration from the clone.
6. Validate, start Pi, and keep the backup until resource discovery and normal
   operation are confirmed.

Rollback is a directory swap back to the private backup.

## Security boundary

Machine-local and sensitive state stays outside the tracked tree. Never weaken
the ignore boundary merely to preserve a mutable local file; use a sanitized
example when portable configuration is genuinely needed.

Pi can update `settings.json` through interactive configuration. Review every
settings diff before committing and keep the tracked file portable.

## Validation

Run:

```bash
node scripts/validate-global-config.mjs
git diff --check
git status --short
```

The validator checks portable package paths, package manifests, JSON files,
resource directories, the canonical shared definition inventory, absence of the
legacy definition directory, linked-file safety, and the tracked-versus-local
boundary.

## Development

Active Pi packages remain under `configs/pi-agent/packages/` so their existing
tests and documentation stay stable. Project-specific implementation records go
under `configs/pi-agent/docs/agents/`; sanitized reusable extracts go into the
matching root shared-material directory.

No commit or push is performed automatically after configuration changes.
