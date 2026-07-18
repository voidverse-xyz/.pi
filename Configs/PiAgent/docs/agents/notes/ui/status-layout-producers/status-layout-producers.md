# Status layout producers

## Decision

The shared Pi status row uses producer/presenter separation:

- `pi-git-status` publishes plain CWD/Git text under `git-status`.
- `pi-model-thinking` publishes `<model> · <thinking>` under `model-thinking`.
- `pi-agents` publishes plain activity text under `subagents`.
- `pi-tool-monitor` publishes plain running-tool text under `tool-monitor`.
- `pi-status-line` reserves all four keys, removes them from generic footer
  aggregation, and owns styling and positioning.

The presenter recreates the width-aware above-editor row with Git left and
model/thinking right. Footer token totals use spaced Nerd Font long-arrow up/down icons so glyph
bearings cannot collide with the values. In the footer,
subagents use line 1-left when present;
tool-monitor uses line 1-left when they are absent and moves to line 2-left when
they are visible. Producer values remain readable if the presenter is disabled.

## Lifecycle

Producers publish during `session_start` and on relevant state changes. The Git
producer also refreshes after turns and every 15 seconds; tool-monitor republishes
its spinner frame while tools run; subagents refreshes from runtime/autonomy events
and polling. All producers clear status on `session_shutdown`. The presenter
installs and removes both its custom footer and `status-line-header` widget with
the session lifecycle.

## Theme

The active Codex theme uses a seven-step progression: gray for off, then a
blue-to-purple-to-red gradient from minimal through max. Because these are Pi's
standard thinking tokens, the progression applies consistently to every Codex
thinking display.
