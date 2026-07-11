# codex-pi

Make [pi](https://github.com/earendil-works/pi) look and work like [OpenAI Codex CLI](https://github.com/openai/codex) — as a set of exportable pi extensions.

Bare-bones pi becomes a 1:1 Codex clone: the `>_ OpenAI Codex` header card, Codex's
colors and tool-call rendering, its slash commands, approval/sandbox modes, multi-agent
orchestration (the marquee feature), plan mode, and code review — all built on pi's
public extension API, importing only pi's bundled modules (no third-party deps).

## Install

Drop the package where pi discovers extensions:

```bash
# Global (all projects):
cp -r codex-pi ~/.pi/agent/extensions/codex-pi

# Or per-project:
mkdir -p .pi/extensions && cp -r codex-pi .pi/extensions/codex-pi
```

pi reads the `pi` manifest in `package.json` and loads the extension (`src/codex.ts`)
plus the two themes. Start pi and you're in Codex.

> Targets published **`@earendil-works/pi-coding-agent` 0.80.3**. Uses only APIs present
> in that runtime (e.g. `registerMessageRenderer`, not the newer `registerEntryRenderer`).

## What you get

| Module | File | Codex parity |
|---|---|---|
| **Theme** | `themes/codex-*.json` | `codex-dark` / `codex-light`, auto-applied over pi's dark/light. Colors from Codex's `style.rs` (cyan accent on dark, `#005f87` on light). |
| **Look** | `src/header.ts` `footer.ts` `working.ts` | `>_ OpenAI Codex (vX)` header card, `? for shortcuts` / `NN% context left` footer, shimmering **Working** indicator (Codex's 2s sweep). |
| **Render** | `src/render.ts` | All 7 built-in tools re-rendered Codex-style: `• Ran`/`Edited`/`Read` bullets, `└` output indents, `(+a -r)` diff counts, colored diffs. |
| **Commands** | `src/commands.ts` | `/status` card, `/diff` (incl. untracked), `/init` (AGENTS.md, verbatim Codex prompt), `/mention`, `/goal`, `/personality` (verbatim Codex templates). |
| **Approvals** | `src/approvals.ts` | `/permissions` (Read-Only / Auto / Full-Access) + a `tool_call` gate; safe-command allowlist ported from Codex; session prefix/file grants. |
| **Subagents** | `src/subagents.ts` | `spawn_agent`, `wait_agent`, `send_input`, `list_agents`, `interrupt_agent`, `close_agent` over real in-memory sessions; `/agents` picker + live status-dot widget. Sub-agents get coding tools only (no recursion). |
| **Plan** | `src/plan.ts` | `update_plan` tool + `✔`/`□` "Updated Plan" render; Plan Mode via Codex's collaboration template; at-most-one-in-progress + plan-mode guards. |
| **Review** | `src/plan.ts` | `/review` runs a nested read-only reviewer session over the working diff. |
| **Composer** | `src/composer.ts` | The input box itself: bold `›` prompt marker, Codex placeholder, dim rules — via `setEditorComponent`. Plus `?` shortcuts panel + `/shortcuts`. |

## Slash commands

`/status` `/diff` `/review` `/plan` `/permissions` `/agents` `/personality` `/goal`
`/init` `/mention` `/shortcuts` — plus pi's built-ins (`/model` `/compact` `/resume`
`/fork` `/new` …).

## Development

```bash
# In the container (see ../setup-container.sh):
node tests/load-check.mjs        # jiti + stubbed ExtensionAPI: renders every surface
../screenshot.sh out.png "/status"   # live TUI screenshot via tmux + konsole
```

`tests/load-check.mjs` loads the extension exactly as pi does (jiti) and exercises the
header, footer, working indicator, all tool renderers, every command, the approval gate,
the subagent tools (mock session), plan/review, and the shortcuts panel.

## Structure

Each module is independent — delete any `src/*.ts` import from `src/codex.ts` to drop that
feature. The manifest loads `src/codex.ts`, which composes them.
