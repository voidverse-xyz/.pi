# pi-safety

Risk-based confirmation gates for **main-agent** `bash` tool calls. User-entered `!` commands are not intercepted, and subagent Bash calls remain governed by `pi-agents` sandbox/escalation rules rather than receiving duplicate prompts.

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

## Audit privacy

Decisions are written to `~/.pi/agent/safety-audit.jsonl`. Command arguments are **never persisted**: records contain only executable names and a short SHA-256 fingerprint for correlation. The file uses owner-only creation permissions and rotates at 1 MiB.

## Files

- `index.ts` — mode, tool-call gate, status, and commands
- `categories.ts` — conservative command classifier
- `delayed-confirm.ts` — countdown confirmation UI
- `audit.ts` — bounded privacy-preserving decision log
- `categories.test.ts` — classifier regression tests
