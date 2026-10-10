# Portable Pi global configuration

This repository is designed to be cloned as the portable Pi configuration tree:

```text
~/.pi
```

Pi's effective global agent directory is `~/.pi/agent`. The tracked
`agent/settings.json` is the sole settings file; package and skill paths resolve
relative to `agent/`. Its resource shims expose the repository's package sources,
skills, shared subagent definitions, and procedure library from that location.
Runtime state and credentials under `agent/` remain ignored.

Clone the whole tree to `~/.pi`. Cloning directly to `~/.pi/agent` no longer
provides settings at Pi's effective agent root.

Keep the root `AGENTS.md` filename uppercase; Pi loads it as global guidance.
`AGENTS.md` at the repository root routes agents to `.agents/AGENTS.md` for shared rules.
`agent/AGENTS.md` is a regular Markdown pointer, not a symlink or duplicate: when
Pi loads it, the agent must read `../AGENTS.md` relative to that pointer file.
This avoids symlink privileges for instruction loading on Windows. Other
resource shims still use symlinks.

It combines portable Pi configuration with reusable agent materials and the
source of the local Pi packages enabled by `agent/settings.json`.

## Layout

```text
<repository-root>/
├── AGENTS.md                 # Routes agents to shared instructions
├── MANIFEST.md               # Enabled Pi package inventory
├── packages/                 # Pi extensions and package-local tests
├── tests/                    # Shared test tools and integration checks
├── docs/                     # Pi-specific development documentation
├── containers/podman/        # Container setup
├── scripts/                  # Pi validation and setup
├── keybindings.json          # Portable keybindings
├── agent/                    # Effective Pi configuration and local runtime
│   ├── settings.json         # Sole settings file
│   ├── packages -> ../packages
│   ├── skills -> ../.agents/skills
│   ├── subagents -> ../.agents/subagents
│   └── procedures -> ../.agents/procedures
└── .agents/                  # Shared-resource Git submodule
    ├── AGENTS.md
    ├── skills/
    ├── subagents/
    ├── procedures/
    ├── plans/
    ├── docs/
    ├── scripts/
    ├── mcp/
    └── codex/
```

The parent owns Pi code and setup. The submodule owns reusable knowledge, roles,
and skills for multiple agents. See [.agents/README.md](.agents/README.md) for its index.
The same subagent definitions serve both Pi Subagents and Pi Teams.
See [Choosing agent coordination](docs/agents/guides/choosing-agent-coordination.md)
for when to use Subagents, Teams, or Swarm, with agent-facing examples and safeguards.

Read this README, `MANIFEST.md`, relevant package documentation, and applicable
`AGENTS.md` instructions before changing the layout or active resources.
Package paths resolve relative to `agent/settings.json` through `agent/packages`.
Pi development records belong in `docs/agents/`; shared material belongs in `.agents/`.

## Submodule workflow

```bash
git clone --recurse-submodules <repository-url> ~/.pi
# For an existing clone:
git submodule update --init --recursive
```

The shared submodule requires repository access. A parent-only clone can inspect
and develop extensions, but the complete personal configuration requires the submodule.
After pulling the parent, run `git submodule update --init --recursive` to use its
recorded shared-resource version. Do not use `--remote` for a reproducible install.

Commit and push shared changes first; then commit and push the parent submodule
pointer. Both repositories must be reviewed independently.

### PiAgent behavior

`packages/` is the source of truth for active package-backed Pi
extensions. `agent/settings.json` enables them with portable relative paths, and
root `.agents/skills/` is the canonical global skill library.

- **Modes:** `pi-plan` provides unrestricted Off plus restricted Discuss, Plan,
  and Quick modes through `/discuss`, `/plan`, `/quick`, and the `Shift+Tab`
  cycle. Quick keeps concise read-only chat; Discuss adds normal-length read-only
  discussion; Plan uses tagged planning skills and an authorized `save_plan`
  path. Plan-mode workers are fresh read-only one-shot Pi Subagents. The Pi-specific
  base instructions live in `.agents/skills/pi-plan-mode/`.
- **MCP:** Pi's built-in MCP support reads server definitions from
  `~/.pi/agent/mcp.json` and provides the `/mcp` command. See
  [MCP migration](#mcp-migration) before using an existing server configuration.
- **Codex helpers:** `pi-codex-web-search` and `pi-codex-image-generation` use
  short-lived Codex clients and the existing ChatGPT login. Image generation
  uses an ephemeral image-only thread, accepts explicit source images, and
  confines output writes to the current working directory.
- **Timers:** `pi-timers` provides main-agent-only in-process recurring timers.
  Ticks coalesce while the agent is busy, and timers disappear on cancellation,
  reload, session replacement, or process exit. `/timers` and `Alt+R` expose
  list/cancel controls.
- **Sessions:** `pi-clear`, `pi-sessions`, `pi-prune`, and `pi-handoff` provide `/clear`,
  `/sessions`, lifecycle-safe session replacement/removal, and fresh continuation sessions
  built from editable active-branch summaries.
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
- **Swarm:** `pi-swarm` is managed through the main agent's start/status/control/history
  tools. The agent proposes sensible settings and explains the full objective and
  configuration in chat; ordinary approval requires exactly `start` as your entire reply
  (lowercase, no whitespace or punctuation). Recovery requires separate settlement evidence. Swarm
  opens no confirmation dialogs and preserves existing work by default. The only direct
  user command is `/swarm stop`. Its Messages/Agents/Topics inspection and **Steer**
  page join Pi agent navigation. Only Steer offers a bordered message editor beside
  a worker's native Pi transcript; other pages remain read-only. The main agent
  handles owner approval, steering, decisions and lifecycle controls; workers coordinate
  task claims, peer handoffs, recruitment and independent review. Settled board transitions
  offer bounded worker wakes, and reviewed work proceeds through recorded final verification
  before a compact result returns to main. Plan and Safety are optional
  integrations. Without Safety, your confirmed bounded run policy authorizes the selected
  worker coding tools; an enabled Safety provider still applies its own policy. Durable
  state lives beside Pi's project sessions, and another session can restore a run paused.
  Loading, reload and session resume never dispatch work automatically. See its
  [usage and recovery](packages/pi-swarm/README.md).
- **User notices and turn statistics:** `pi-notify-user` renders structured
  end-of-turn notices with optional urgent toasts. `pi-turn-stats` emits a
  compact TUI-only notice after the agent truly settles; it does not alter the
  prompt or add model work.
- **Change tracking:** `pi-changes` records the main agent's successful
  `edit`/`write` touches with first-touch baselines. `/changes` provides
  git-independent diffs, file browsing, isolated read-only questions, and
  precise per-file undo where a safe baseline exists. Bash-made changes are out
  of scope.
- **Theme and keys:** `packages/void-agent/themes/` contains the
  tracked theme family. `agent/settings.json` selects the active theme, and root
  `keybindings.json` assigns thinking/model cycling while reserving `Shift+Tab`
  for `pi-plan`.

Mutable extension settings and all session/runtime state remain ignored. Run
`/reload` or restart Pi after changing a package, skill, subagent definition,
keybinding, or theme.

## Fresh installation

Back up an existing Pi directory before replacing it. Do not copy its settings
file over this repository's portable settings.

Whole-tree install:

```bash
mv ~/.pi ~/.pi.backup
git clone --recurse-submodules <repository-url> ~/.pi
chmod 700 ~/.pi ~/.pi/agent
node ~/.pi/scripts/validate-global-config.mjs
```

Authenticate with `/login`. When migrating an existing installation, restore
only the machine-local state you intentionally preserved in the private backup;
keep it outside Git and retain its restrictive permissions.

The enabled Swarm package requires **Pi 1.0.4+ and Node 22.19+**; Pi 1.0.4 is
its verified runtime baseline, and later versions require revalidation.
Start Pi and run `/reload` after resource changes. Built-in MCP requires
[Pi 0.99.0 or later](https://github.com/earendil-works/pi/releases/tag/v0.99.0).
The previous Pi 0.83.0 test baseline predates built-in MCP; it is not a verification
of the new runtime. Check each package's supported versions, especially the
version-gated optional `void-agent` renderer patches. Package features may also
require Git, a Nerd Font, or the external tools named in their READMEs.

## MCP migration

The removed local client and built-in MCP use different configuration contracts.
Back up the existing configuration privately, then convert it before enabling
servers. Follow Pi's [MCP documentation](https://pi.dev/docs/latest/mcp):

- Move server entries from top-level `servers` to `mcpServers`; remove the old
  `version`, `eagerToolLimit`, and `eagerSchemaBytes` options.
- Convert environment-variable mappings to interpolation. For example,
  `"SERVICE_TOKEN": "SOURCE_SERVICE_TOKEN"` becomes
  `"SERVICE_TOKEN": "${SOURCE_SERVICE_TOKEN}"`; keep credentials out of the file.
- Set an explicit absolute `cwd` if the server relied on the old agent-directory
  default. Built-in relative working directories resolve against the session.
- Convert `callTimeoutMs` to `timeout` in seconds. Remove old `startupTimeoutMs`,
  `autoRestart`, and `confirm` fields; review the built-in lifecycle and permission
  behavior instead of assuming equivalent settings. The old per-call confirmation
  default is not preserved by this migration; configure an appropriate permission
  gate before enabling servers that require approval.
- Use the standard user or trusted-project configuration location instead of
  relying on the removed `PI_MCP_CONFIG` override. Update any saved tool references
  for built-in names and discovery; the old `mcp_search_tools` helper is gone.

After reviewing the converted configuration, `pi mcp list` connects enabled
servers and reports errors. Use `/mcp` to inspect them and `/reload` after edits.

## Existing-machine cutover

1. Stop Pi processes.
2. Make a private backup of the complete existing `~/.pi` directory.
3. Preserve required machine-local state privately.
4. Clone this repository to an empty `~/.pi`.
5. Restore only the private state needed under `~/.pi/agent`; keep the portable
   tracked configuration from the clone.
6. Validate, start Pi, and keep the backup until resource discovery and normal
   operation are confirmed.

Rollback is a directory swap back to the private backup.

## Security boundary

Machine-local and sensitive state stays outside the tracked tree. Never weaken
the ignore boundary merely to preserve a mutable local file; use a sanitized
example when portable configuration is genuinely needed.

Pi can update `agent/settings.json` through interactive configuration. Review every
settings diff before committing and keep the tracked file portable.

## Managed Pi compatibility

The 32 enabled packages have automated compatibility coverage for managed Pi 1.0.4 on Linux.
See [runtime compatibility and verification](docs/agents/notes/ops/standalone-extension-compatibility/standalone-extension-compatibility.md)
for the supported contracts, full suite, compiler prerequisites, and untested runtime boundaries.
`PI_SDK_DIR` can select another SDK; otherwise the test tooling follows the managed install's
current version and resolves its hoisted dependencies. Updating Pi does not update a separate
copy of this configuration repository.

## Validation

Run:

```bash
node scripts/validate-global-config.mjs
node --test scripts/validate-global-config.test.mjs
python3 .agents/tests/shotcut.test.py -v
git diff --check
git status --short
```

The validator reads `agent/settings.json` and checks its portable package paths
and package manifests through `agent/packages`. It also checks JSON files,
resource directories, the canonical shared definition inventory, absence of the
legacy definition directory, linked-file safety, and the tracked-versus-local
boundary.

## Development

Active Pi packages remain under `packages/` alongside shared test tooling in `tests/`. Project-specific implementation records go
under `docs/agents/`; sanitized reusable extracts go into the
matching `.agents/` directory.

No commit or push is performed automatically after configuration changes.
