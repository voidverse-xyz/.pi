# pi-run-summary

Shows one compact Pi notification after the main agent fully finishes:

```text
• Implemented the requested completion summary.
   45.2k ·  3.1k ·  2m 14s
```

Terminal UIs cannot change font size per line, so the telemetry line uses the
active theme's dim tertiary-text color to give it less visual weight.

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
- adds a stable TUI-only system instruction asking the same model to append one
  concise outcome sentence after a blank line in a terminal `pi-run-summary`
  Markdown reference definition. Pi hides the completed definition, although an
  incomplete marker prefix can appear briefly while the response is streaming;
- captures and removes that marker in `message_end` before the finalized response
  is stored, then uses its text in the completion notification. Malformed reserved
  marker lines are scrubbed and use the fallback instead;
- falls back to the first meaningful final-response sentence when the marker is
  absent, including length/error/abort cases. Neither path hard-truncates the
  summary; Pi's text component wraps it to the available terminal width;
- makes no additional model call or round trip. The hidden outcome adds only its
  instruction and a short sentence to the existing turn's token usage;
- emits and requests summaries only in interactive TUI mode. It keeps Pi's
  `info` notification path, renders the outcome in the active theme's `muted`
  secondary-text color, and puts token/time telemetry on a second line in the
  `dim` tertiary-text color.

Enable the package by adding its directory to Pi's `packages` setting, then run
`/reload` or restart Pi.
