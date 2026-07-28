# pi-subagents

Background fan-out workers for Pi with a strict hub-and-spoke model: subagents
can report to the main agent but cannot spawn, inspect, or message peers.

## Main-agent tools

- `subagent_spawn` — create or wake a typed or ad-hoc worker
- `subagent_send` / `subagent_steer` — assign follow-up or in-flight guidance
- `subagent_await` — join one, several, or all open assignments
- `subagent_cancel` / `subagent_retire` — stop a turn or permanently archive an agent
- `subagent_status` — inspect the owning-session `ownerScopeId`, roster, vitals, open tasks, and transcript tails

## Display labels

`subagent_spawn` requires the LLM to provide a concise, task-specific `label`.
The ambient widget, roster picker, and viewer use that label instead of exposing
an anonymous address such as `adhoc/tmp-a1b2c3d4`.

A persistent agent keeps the label from its first creation. Later get-or-create
spawns cannot silently rename it. Labels persist in the session-scoped registry
and retirement marker, so they survive restart and remain visible for archived
agents. Pre-label tool calls receive a deterministic compatibility label before
validation; old registries and archive markers without labels still load.

## Activity widget

While agents are working, the above-editor tree shows one row per agent:

```text
 2 running · 1 waiting · 󰇮 3 · alt+a stop
├─ test runner ·  10 tools ·  12k tokens ·  18%
│  └ Bash: npm test
└─ source scout ·  3 tools ·  8.1k tokens ·  11%
   └ Read: src/index.ts
```

Metric semantics:

- **tools** — exact tool executions started during the current mail-driven turn;
- **tokens** — cumulative Pi session tokens for that subagent;
- **context** — current model-context fill on Pi's 0–100 percent scale, or `?`
  before Pi can calculate it.

Current-tool text follows `tool_execution_start`/`tool_execution_end`. Before any
provider-visible thought arrives, the row shows `thinking…`; afterward it keeps
the latest thought visible as `<thought> · thinking…` while the model continues.
At ordinary widths, the label is truncated before metrics. At narrow widths the
widget moves all three metrics to a compact second row so telemetry remains
visible.

The `/subagents` picker and full-screen viewer also show labels, compact token
counts, and corrected context percentages. `alt+a` stops all working subagents
without retiring them.

## Verification

Run the strict typecheck and all standalone harnesses:

```bash
./test/e2e/run.sh
```
