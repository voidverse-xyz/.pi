# codex-pi — Codex CLI as pi extensions

Goal: a 1:1 clone of Codex CLI's look and functionality, built as **exportable pi
extensions** (installable by dropping the package into `~/.pi/agent/extensions/` or a
project `.pi/extensions/`). Later we add our own features on top.

Workspace layout:
- `pi/` — pi source (reference, shallow clone)
- `codex/` — Codex CLI source (reference, shallow clone)
- `codex-pi/` — **our extension package** (the deliverable)
- `setup-container.sh` — provision the fedora-desktop container

Container: `fedora-desktop` (webtop KDE, http://localhost:3000), this dir mounted at
`/config/workspace`. pi installed globally (`pi` on PATH).

## Extension suite (each independently loadable, one package manifest)

| Module | Codex source of truth | Pi mechanism |
|---|---|---|
| **codex-theme** | `tui/src/style.rs`, `color.rs`, `render/highlight.rs` | theme JSON via `resources_discover.themePaths` + `setTheme` |
| **codex-look** | `onboarding/welcome.rs`, `bottom_pane/footer.rs`, `status_indicator_widget.rs`, `frames.rs`, `shimmer.rs` | `setHeader`, `setFooter`, `setWorkingIndicator`, `setStatus` |
| **codex-render** | `history_cell/{messages,exec,patches}.rs` | re-register built-in tools with `renderCall`/`renderResult`; message styling (`• ` bullets, `└ ` indents) |
| **codex-commands** | `slash_command.rs` | `registerCommand`: /status /diff /init /mention /rename /usage /copy /raw /permissions /personality /goal … |
| **codex-approvals** | `protocol.rs` AskForApproval + SandboxPolicy, `approval_overlay.rs` | `tool_call` blocking + approval overlay via `ctx.ui.custom`; modes: untrusted / on-request / never |
| **codex-subagents** | `multi_agents_spec.rs`, `multi_agents.rs`, `tui/src/multi_agents.rs` | tools spawn_agent / send_input / wait_agent / list_agents / close_agent / interrupt_agent over `createAgentSession` (in-memory sessions); `/agents` picker |
| **codex-plan** | `plan_spec.rs`, `history_cell/plans.rs`, collaboration-mode-templates | `update_plan` tool + renderer; `/plan` collaboration mode via `before_agent_start` systemPrompt |
| **codex-review** | `core/src/tasks/review.rs` | `/review` — nested `createAgentSession` over the diff |
| **codex-composer** | `bottom_pane/chat_composer.rs`, `keymap.rs` | `setEditorComponent` (CustomEditor subclass): Tab queue, `?` shortcut overlay, Ctrl+J newline, Ctrl+R history |

Build order = table order (theme first, everything renders on top of it; subagents are
the marquee feature and come once approvals exist so spawned agents inherit policy).

## Key constraints (learned from source)

- Packaged pi extensions may only import pi's bundled virtual modules
  (`@earendil-works/pi-tui`, `pi-coding-agent`, `pi-agent-core`, `pi-ai`, `typebox`).
  No third-party npm deps.
- Pi theme schema is **closed** (~60 slots, `theme/theme-schema.json`) — codex colors map
  onto those slots; anything beyond goes through raw ANSI in custom components.
- Codex derives colors from terminal bg/fg at runtime (accent: cyan on dark,
  RGB(0,95,135) on light; user-msg bg: white@0.12 blend on dark, black@0.04 on light).
  We ship `codex-dark` + `codex-light` themes computed against standard bg values.
- Pi has no approval or subagent framework built in — both are pure extension territory
  (`tool_call` block; `createAgentSession` from the SDK).
- Pi already has: sessions/resume/fork/tree, compaction, themes, models/OAuth, skills,
  export/share — we skin these rather than rebuild.

## Testing

- Typecheck: `npx tsc --noEmit` against pi's exported types (pi repo checked out for the
  real .d.ts surface).
- Harness: load extensions with jiti + a stubbed ExtensionAPI (pattern from earlier
  pi-* projects), assert registrations and event behavior.
- Live: run `pi` inside the container (KDE terminal at localhost:3000) in a scratch
  project whose `.pi/extensions` points at `codex-pi/`.
