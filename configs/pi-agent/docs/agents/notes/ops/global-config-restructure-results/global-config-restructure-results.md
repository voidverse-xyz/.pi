# Global Pi configuration restructure results

## Outcome

The repository root now represents the portable source form of `~/.pi/agent` and is staged as one coherent migration. It can be archived or committed and cloned directly into the global Pi agent directory without global symlinks or host-specific package paths.

## Lowercase directory convention

Repository-owned directories now use lowercase hyphen-case. The shared roots are `codex/`, `configs/`, `mcp/`, `plans/`, and `procedures/`; owned nested directories are `codex/configs/`, `codex/plugins/`, `configs/pi-agent/`, `configs/podman/`, and `configs/subagent-docs/`. `AGENTS.md` remains uppercase at the global-config root because Pi auto-discovers that exact filename.

## Active root resources

- `settings.json`: selected theme plus 25 relative local-package paths
- `keybindings.json`: `Alt+T` thinking cycle and `Alt+M` model cycle
- `skills/`: 38 globally discoverable skills
- `subagents/`: production definitions shared by `pi-subagents` and `pi-teams`
- `scripts/validate-global-config.mjs`: clone-safety and resource validation
- `README.md`: fresh install, cutover, rollback, security, and validation

Test-only `test-fixture.md` and `test-runner.md` moved from global definition discovery into `configs/pi-agent/packages/pi-subagents/test/fixtures/type-definitions/`.

## Quarantined unmatched Pi material

The following tracked sources moved into the ignored local directory `tmp/pi-global-config-migration/unmatched-pi/`, preserving their original relative layout:

1. legacy source `Configs/PiAgent/.pi/`
2. legacy source `Configs/PiAgent/packages/_archive/`
3. legacy source `Configs/Archive/PiAgent/`
4. legacy source `Configs/Archive/codex-pi/`

The quarantine contains 231 files. Hash comparison confirmed each quarantined file is byte-identical to its former tracked source. The only extracted file from the old nested export was legacy `Configs/PiAgent/.pi/agent/keybindings.json`, promoted without content changes to root `keybindings.json`.

The quarantine is deliberately absent from the staged/indexed clone and should remain local until the user decides it is no longer needed.

## Portability corrections

- Removed Pi Plan's package-relative `Skills/plan` registration and hard-coded tagged-skill discovery. Plan mode now uses Pi's normal root global skill discovery.
- Added missing peer dependency declarations for imports used by `pi-bookmark`, `pi-commit`, `pi-show-files`, and `pi-todo`.
- Updated `pi-subagents`, `pi-teams`, and `pi-procedure` production initialization to pass Pi's effective `getAgentDir()` into their path authorities, so `PI_CODING_AGENT_DIR` and embedded configurations do not read or write the default live directory.
- Corrected the Void Agent persistence test for the existing `themeInitialized` field and shortened one over-limit skill description so resource loading has no diagnostics.
- Refreshed active shortcut documentation and removed tracked references that could invite archived package activation.

## Security boundary

The root ignore policy covers Pi credentials, private model/provider overrides, sessions, trust, managed package and binary directories, caches, logs, databases, environment files, private keys, Codex runtime state, extension-owned mutable settings/audits, and migration quarantine. The validator now fails when any nonignored file is untracked or any tracked path matches the private/runtime ignore policy.

A filename-only high-confidence secret scan found zero matches in the staged/intended tree and zero matches across Git history. `gitleaks` was not available on the host.

## Verification

- Configuration validator: pass
- Indexed direct-clone smoke test: pass
- `pi list` from isolated `$HOME/.pi/agent`: 25 relative packages resolved
- Resource loader from indexed snapshot: 25 extensions, 38 skills, 7 themes, 0 prompts, 0 errors/diagnostics
- Plan, safety, show-files, todo, turn-stats, and Void Agent tests: pass
- `pi-subagents`: strict typecheck plus all 10 harnesses pass
- `pi-teams`: strict typecheck plus all 11 harnesses pass
- `pi-procedure`: 57 unit tests, strict typecheck, and all 5 harnesses pass
- Definition parity, independent-file checks, JSON validation, ignore probes, staged diff whitespace check, and no-symlink check: pass

## Live-host bridge

The live `~/.pi/agent` directory has not yet been replaced by a direct clone, but its resource bridge is repaired:

- `keybindings.json` links to repository-root `keybindings.json`.
- `skills` links to repository-root `skills/`.
- `subagents` links to repository-root `subagents/`.
- Live Pi package entries point to the lowercase `configs/pi-agent/packages/` source tree.
- `~/.codex/config.toml` points to lowercase `codex/configs/config.toml`.
- Obsolete `agents`, `extensions`, and `themes` links were removed; extensions and themes remain package-backed through live settings, avoiding duplicate discovery.

A live resource-loader check resolves 25 extensions, 38 skills, and 7 themes with zero errors or diagnostics, so `/reload` is safe again. A later full cutover should still stop Pi, back up the live directory, clone the committed repository into an empty `~/.pi/agent`, restore only ignored credentials and sessions, and validate before deleting the backup or local quarantine.
