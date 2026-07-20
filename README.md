# Portable Pi global configuration

This repository is designed to be cloned as the portable Pi configuration tree:

```text
~/.pi
```

Pi's effective global agent directory is still `~/.pi/agent`; the tracked
`agent/` shims expose the repository's settings, keybindings, context, skills,
package sources, subagent/team definitions, and workflow library from that
location. Runtime state and credentials under `agent/` remain ignored.

The repository can also be cloned directly to `~/.pi/agent`; in that layout the
root files are Pi's effective agent config and the nested `agent/` shims are
dormant.

It combines portable Pi configuration with reusable agent materials and the
source of the local Pi packages enabled by `settings.json`.

## Layout

```text
~/.pi/agent/
├── AGENTS.md                 # Global agent instructions
├── settings.json             # Portable settings; relative package paths
├── keybindings.json          # Global keybindings
├── skills/                   # Auto-discovered global Pi skills
├── subagents/                # pi-subagents type definitions
├── teams/                    # pi-teams type definitions
├── configs/pi-agent/packages/ # Active local Pi packages
├── configs/pi-agent/docs/     # Package-specific plans and notes
├── plans/                    # Reusable plans and procedures
├── workflows/                # Reusable Markdown workflow procedures
├── agent/                    # Compatibility shims when repo is cloned as ~/.pi
├── codex/                    # Codex configuration sources
├── mcp/                      # Reusable MCP definitions and notes
└── scripts/                  # Configuration validation
```

Pi ignores the extra reusable-material trees unless a package or setting refers
to them. Root `workflows/*.js` is reserved for executable saved `pi-workflow`
scripts; reusable Markdown procedures live in nested `workflows/<domain>/`
directories, which the workflow loader ignores.

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
`0.80.10`; package features may also require Git, a Nerd Font, or the external
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
resource directories, production definition parity, linked-file safety, and the
tracked-versus-local boundary.

## Development

Active Pi packages remain under `configs/pi-agent/packages/` so their existing
tests and documentation stay stable. Project-specific implementation records go
under `configs/pi-agent/docs/agents/`; sanitized reusable extracts go into the
matching root shared-material directory.

No commit or push is performed automatically after configuration changes.
