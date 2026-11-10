# pi-safety

Risk-based confirmation gates for **main-agent** `bash` tool calls and forwarded worker requests. User-entered `!` commands are not intercepted. Teams, Subagents, and Procedure retain their existing confirmation channels and policies.

## Modes

```text
/safety
/safety max
/safety on
/safety off
```

| Mode | Behavior | Status foreground |
|---|---|---|
| `max` (default) | Confirm everything except commands conservatively proven read-only | Red |
| `on` | Confirm commands classified as destructive | White |
| `off` | Do not confirm Bash calls | Grey |

The selected mode is stored in `~/.pi/agent/safety.json`. Invalid or unreadable configuration fails back to `max` with a warning. `/safety-log` shows the 20 most recent decisions.

## Categories

- **Destructive** — two confirmations, each delayed for three seconds
- **Network** — one confirmation delayed for three seconds
- **Exec** — one immediate confirmation
- **Other** — one immediate confirmation in `max` mode
- **Read-only** — automatically allowed

Classification is deliberately conservative. Unknown commands, environment-prefixed commands, output-producing flags, external preprocessors, and commands with unproven shell behavior fall into a gated category in `max` mode.

Confirmations are serialized, so parallel Bash tool calls cannot stack overlapping dialogs. In the TUI, use `q` or `n` to cancel at any point; `Esc` remains a fallback. In print/JSON modes, gated commands fail closed because no confirmation UI is available. RPC uses its normal confirmation UI.

## Swarm confirmation provider

`swarm:confirm-request` uses the synchronous claim envelope
`{ method: "confirm", request, claim(fn) }`. The claimed async function accepts a
request and returns `{ approved: boolean, note?: string }`. Requests require a
real `AbortSignal`, a tool of `bash`, `edit`, or `write`, and a nonblank `command`
(for Bash) or `path` (for edits/writes); `agent` is an optional display label.
Malformed requests deny. Without a live TUI the provider does not claim, so the
requester must fail closed. This provider does not activate Swarm.

Swarm reuses the existing Bash classifier and modes; edits/writes are `other`
and are confirmed in `max`, independently of the main agent's opt-in
`/safety-writes` gate. No new command classification or path policy is introduced.

Cancellation uses the request signal and the provider session lifetime, never
an unrelated main-agent run signal. Session start/replacement, shutdown, tree
navigation, or a safety-mode change revokes pending requests and stale claims.
A direct request has a maximum two-minute confirmation lifetime including queue
time. Canceled waiters deny promptly but keep their serialization slot until the
preceding/active UI actually settles; canceled queued requests never open UI.
Active dialogs close through their normal cancellation hook, including between
destructive confirmation steps. Policy/lifetime is rechecked before opening UI
and after approval.

## Audit privacy

Decisions are written to `~/.pi/agent/safety-audit.jsonl`. Command arguments are **never persisted**: records contain only executable names and a short SHA-256 fingerprint for correlation. The file uses owner-only creation permissions and rotates at 1 MiB.

## Files

- `index.ts` — mode, tool-call gate, status, and commands
- `categories.ts` — conservative command classifier
- `delayed-confirm.ts` — countdown confirmation UI
- `audit.ts` — bounded privacy-preserving decision log
- `categories.test.ts` — classifier regression tests
- `test/` — isolated confirmation and provider lifecycle tests (no live UI/models)

## Validation

From the repository root, with the Pi SDK already installed:

```bash
node --experimental-strip-types --experimental-import-meta-resolve \
  --import ./packages/pi-safety/test/sdk-register.mjs \
  --test packages/pi-safety/extensions/safety/categories.test.ts \
  packages/pi-safety/test/*.test.mjs
```

The test resolver uses public installed SDK imports (`PI_SDK_DIR` may override
its package directory). Provider tests confine configuration and audit I/O to a
disposable fixture. They do not change active settings or activate any package.
