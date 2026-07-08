# pi-confirm-stop-agent

Confirms before actions that would interrupt an in-flight agent run.

## What it does

While the agent is working, the following actions silently stop the current run and any
in-flight tool or bash work: starting a new session, switching sessions, cloning/forking,
and opening the session tree. This extension intercepts each of those (via the
`session_before_switch`, `session_before_fork`, and `session_before_tree` events) and
shows a selector first:

| Choice | Effect |
|--------|--------|
| **Stop the run** | Proceed with the action (this run is stopped). |
| **Stop the run and don't ask again this session** | Proceed, and auto-approve all later interrupt confirmations for the rest of this process. |
| **Cancel** (or `Esc`) | Abort the action; the run keeps going. |

If the agent is idle, no dialog is shown and the action proceeds normally.

## "Don't ask again this session"

The skip flag is a module-scoped boolean — it is never persisted to disk. It lasts for
the lifetime of the pi process and resets when you restart pi. It also resets on
`/reload`, since reloading re-evaluates the extension module (pi loads extensions with
the module cache disabled), so module state starts fresh.

## Install

Loaded as a pi package: list this package's path in `~/.pi/agent/settings.json`
`packages[]`, then `/reload`.
