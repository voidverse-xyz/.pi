# Pi turn stats and subagent telemetry

## Scope

Two related TUI improvements provide ambient execution telemetry:

1. `pi-turn-stats` emits compact main-agent token/time telemetry after a settled user turn.
2. `pi-subagents` uses human labels and shows per-agent tool, token, and context
   telemetry in its ambient activity tree.

## Main-agent turn stats

`pi-turn-stats` starts one in-memory accumulator at the first `agent_start` and
aggregates finalized assistant usage at `agent_end`. It finalizes when
`agent_settled` observes Pi as idle; automatic retries and queued continuations
remain in the same accumulator until that boundary.

The one-line TUI notice has this shape:

```text
 45.2k ·  3.1k ·  2m 14s
```

`` is Pi's uncached `usage.input` bucket and `` is `usage.output`; cache read and
write buckets are deliberately omitted. The notice contains no outcome summary:
the extension does not modify the system prompt, rewrite messages, parse hidden
markers, or add model tokens.

All styling follows the active theme. Icons use `muted`, values use `text`, and
separators use `dim`; no fixed ANSI colors are embedded. Non-TUI modes do not emit
the notice.

## Subagent labels

The public `subagent_spawn` schema requires a short `label`, reinforced by a
prompt guideline. A `prepareArguments` compatibility shim supplies a bounded
local label when an old stored tool call lacks the field.

The first label assigned to a persistent address is stable: get-or-create wakes
cannot silently rename it. Labels are optional in the version-1 registry format
so old records remain readable; the next labeled spawn fills an unlabeled record.
Retirement markers also carry optional labels, preserving names in the archive
without breaking older markers.

Internal addresses remain the routing key and continue to appear in tool
results/status JSON. TUI surfaces use the label.

## Live subagent telemetry

Each active row carries:

- exact `tool_execution_start` count for the current mail-driven turn;
- cumulative subagent session tokens from `getSessionStats()`;
- context fill on Pi's 0–100 percent scale;
- the currently executing tool summary, returning to `thinking…` after the last
  `tool_execution_end`.

Finalized token/context stats refresh after `message_end` persistence using a
microtask. Parallel tools are tracked by call id so the current-tool field stays
valid until the last active sibling ends.

At normal widths, labels are truncated before telemetry. At narrow widths, a
compact dedicated telemetry row preserves tool count, tokens, and context while
label and tool-summary text yield first.

## Compatibility and verification

Coverage includes:

- strict TypeScript checking and extension load registration;
- required label schema, prompt guidance, and legacy argument preparation;
- stable repeated upsert/get-or-create labels;
- old unlabeled/corrupt-label registries and pre-label archive markers;
- label persistence across restart and retirement;
- execution-start/end activity transitions with parallel tools;
- cumulative tokens and context during a live turn;
- 80-character labels, narrow layouts, and ANSI-aware width bounds;
- the full existing subagent lifecycle, await, wake, control, and sandbox suites;
- turn-stats timing, idle gating, token aggregation, theme rendering, mode
  suppression, and shutdown cancellation.

Verification commands:

```bash
configs/pi-agent/packages/pi-subagents/test/e2e/run.sh
node --test configs/pi-agent/packages/pi-turn-stats/test/turn-stats.test.mjs
```
