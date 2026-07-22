# Turn-stats lifecycle

## Goal

Provide compact end-of-turn input/output token and elapsed-time telemetry without
asking the model to generate an outcome summary or modifying conversation content.

## Design

1. `pi-turn-stats` starts one in-memory accumulator at the first `agent_start`.
2. Every `agent_end` adds finalized assistant `usage.input` and `usage.output`.
   Cache read/write buckets remain omitted to match the compact notice contract.
3. Retries, tool-call turns, and queued automatic continuations remain part of
   the same user turn because Pi does not emit `agent_settled` until no automatic
   work remains.
4. `agent_settled` finalizes immediately when `ctx.isIdle()` is true. If an earlier
   handler has already started another run, the accumulator remains open.
5. TUI mode emits one `info` notification; RPC, JSON, and print modes stay silent.
6. `session_shutdown` discards an unfinished accumulator.

The notice is one line:

```text
 45.2k ·  3.1k ·  2m 14s
```

## Theme contract

The extension emits no fixed ANSI colors. It styles each semantic segment through
the active Pi theme:

- `muted`: input, output, and clock icons;
- `text`: token counts and elapsed duration;
- `dim`: separators.

This mirrors the theme-owned hierarchy used by other ambient Pi UI such as the
todo widget.

## Removed summary protocol

The former run-summary implementation appended a hidden Markdown reference marker
to the system prompt, stripped it in `message_end`, and displayed its generated
outcome above the telemetry. Turn stats intentionally removes that entire path:
there are no input, `before_agent_start`, context, or `message_end` hooks; no
summary fallback, hidden marker, model instruction, or summary token overhead.

## Verification

- Assert token and duration formatting boundaries.
- Assert semantic segments use `muted`, `text`, and `dim` theme tokens.
- Assert the extension registers only `agent_start`, `agent_end`, `agent_settled`,
  and `session_shutdown`.
- Assert retries and continuations aggregate into one user turn.
- Assert non-idle settled boundaries keep the accumulator open.
- Assert only `agent_start`, `agent_end`, `agent_settled`, and `session_shutdown`
  are registered.
- Assert session shutdown discards unfinished state.
- Assert non-TUI modes emit nothing.
- Run a black-box RPC load check in binary-only Pi installations.
