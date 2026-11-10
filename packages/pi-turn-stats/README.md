# pi-turn-stats

Shows one compact Pi notification after the main agent fully settles:

```text
 45.2k ·  3.1k ·  2m 14s
```

The notice contains telemetry only—there is no generated outcome summary, hidden
Markdown marker, system-prompt instruction, message rewriting, or extra token cost.

The extension:

- starts timing at the first `agent_start` and emits only when `agent_settled`
  observes Pi as truly idle;
- keeps retries, tool-call turns, and queued automatic continuations in the same
  user turn while Pi has not become idle;
- registers no input, prompt, context, or message-rewrite hooks;
- totals Pi's `usage.input` and `usage.output` buckets from every finalized
  assistant message in that turn. The Nerd Font up arrow (``) is uncached input,
  matching Pi's footer; cache read/write (`R`/`W`) buckets are intentionally
  omitted;
- formats counts and elapsed wall time with Pi-style compact units;
- emits only in interactive TUI mode through Pi's `info` notification path;
- applies no fixed ANSI colors. The active theme keeps the telemetry understated:
  icons and separators use `dim`, while values use `muted`.

Enable the package through `"./packages/pi-turn-stats"` in the
`agent/settings.json`, then run `/reload` or restart Pi.

## Verification

```bash
node --test packages/pi-turn-stats/test/turn-stats.test.mjs
```

The suite exercises formatting, theme rendering, and the complete lifecycle with
a local ExtensionAPI harness, then runs a black-box RPC load check against the
installed Pi binary.
