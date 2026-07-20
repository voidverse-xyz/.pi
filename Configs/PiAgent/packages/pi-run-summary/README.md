# pi-run-summary

Shows one muted Pi notification after the main agent fully finishes:

```text
• Implemented the requested completion summary. ·  45.2k ·  3.1k ·  2m 14s
```

The extension:

- starts timing at the first `agent_start` and emits only at a truly idle
  `agent_settled` boundary, deferred by one event-loop tick so an immediate
  extension-triggered wake can cancel it;
- keeps retries, tool-call turns, and queued continuations in the same run while
  Pi has not become idle;
- totals Pi's `usage.input` and `usage.output` buckets from every finalized
  assistant message in that run. The Nerd Font up arrow (``) is uncached input,
  matching Pi's footer; cache read/write (`R`/`W`) buckets are intentionally
  omitted;
- leads with a simple bullet and the outcome, derived from the first meaningful
  sentence of the final assistant text, then shows spaced Nerd Font input/output
  icons (``/``) and ends with a clock icon (``) plus elapsed time;
  common Markdown is stripped and the summary is truncated to one compact line;
- makes no additional model call and adds no summary latency or token use;
- emits only in interactive TUI mode. It keeps Pi's `info` notification path
  for the compact chat line while explicitly using the active theme's `muted`
  secondary-text color instead of the dim tertiary-text color.

Enable the package by adding its directory to Pi's `packages` setting, then run
`/reload` or restart Pi.
