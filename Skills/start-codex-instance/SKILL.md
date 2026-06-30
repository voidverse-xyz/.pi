---
name: start-codex-instance
description: Start and manage project-specific Codex Incus containers using the agent-tools launcher. Use when the user asks to start a Codex instance/container, launch Codex for a project, pair Codex remote control, create an Incus agent environment, or run start-codex.sh for a project under /home/john/Agents/Projects.
---

# Start Codex Instance

## Purpose

Use `/home/john/Agents/Projects/agent-tools/start-codex.sh` to create a new Incus container for a project and start Codex remote control pairing.

## Workflow

1. Resolve the project path.
   - If the user gives a project name like `squeezarr`, use `/home/john/Agents/Projects/<name>`.
   - If the user gives a path, use that path directly after verifying it exists.

2. Check for an existing Incus container with the project basename:

   ```bash
   incus info <project-name>
   ```

   The launcher is one-time use per container name and fails when the container already exists. Do not delete existing containers unless the user explicitly asks.

3. Run the launcher from the agent-tools repo:

   ```bash
   ./start-codex.sh /home/john/Agents/Projects/<project-name>
   ```

   For pairing helper arguments, pass them after `--`:

   ```bash
   ./start-codex.sh /home/john/Agents/Projects/<project-name> -- --wait 300
   ```

4. Use escalation when running the launcher, because it creates and configures Incus containers and installs packages.

5. Watch the command until it exits. Do not leave a long-running session unobserved.

6. Report the result:
   - container name
   - project mount path
   - pairing code and expiry if produced
   - any failure point and the exact final error line

## Expected Container Layout

For `/home/john/Agents/Projects/squeezarr`, the container name is `squeezarr` and the project mount is:

```text
/root/squeezarr
```

The launcher also sets up:

```text
/root/Documents        read-only shared agent documents
/root/.claude          copied Claude config
/root/.claude.json     copied Claude account file
/opt/codex-home        Codex install, auth, config, and runtime state
/opt/claude-home       Claude installer home
/opt/codex-linux-pair  cloned Codex pairing helper repo
```

Top-level entries from `/root/Documents` are symlinked into `/root` when no same-named target exists.

## Notes

- The launcher installs `bash`, `bubblewrap`, `ca-certificates`, `curl`, `git`, OpenSSH client tools, `python3`, and `tar`.
- Codex auth is copied from `/home/john/.codex/auth.json` to `/opt/codex-home/auth.json`.
- Claude auth/config is copied from `/home/john/.claude` and `/home/john/.claude.json` to `/root`.
- The Codex pairing helper is cloned from `https://github.com/voidverse-xyz/codex-linux-pair.git` and run with `--install-startup`.
- If a partial run fails, ask before deleting or recreating the container.
