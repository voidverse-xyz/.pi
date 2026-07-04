# Pi Coding Agent — Setup & Extension Development Guide

Collected: 2026-07-03  
Machine: Windows 11 (`DenTeach`)  
Pi version installed: **0.80.3**

---

## What Is Pi?

Pi is a **minimal agent harness** — a coding agent CLI you customize to fit your workflow rather than adapting to a predefined system.

- Supports **15+ AI providers** (Anthropic, OpenAI, Google, etc.) and hundreds of models
- Features: tree-structured session history, context engineering, extensibility
- License: **MIT**
- npm package: `@earendil-works/pi-coding-agent`
- GitHub: https://github.com/earendil-works/pi
- Docs: https://pi.dev/docs/latest
- Package registry: https://pi.dev/packages
- Discord: https://discord.com/invite/3cU7Bz4UPx

Pi is **not** the same as the Cursor IDE agent. Pi is its own terminal-based coding agent. You can extend Pi to *use* Cursor models via a custom provider extension (see below).

---

## Install Pi

### Methods

```powershell
# PowerShell (Windows)
powershell -c "irm https://pi.dev/install.ps1 | iex"

# npm (works on all platforms)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# pnpm
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent

# bun
bun add -g --ignore-scripts @earendil-works/pi-coding-agent

# curl (macOS/Linux)
curl -fsSL https://pi.dev/install.sh | sh
```

`--ignore-scripts` is recommended — Pi does not need npm lifecycle scripts for normal installs.

### Verify install

```powershell
where.exe pi
pi --version
npm list -g @earendil-works/pi-coding-agent
```

On this machine:
- CLI: `C:\Users\DenTeach\AppData\Roaming\npm\pi.cmd`
- Package: `@earendil-works/pi-coding-agent@0.80.3`
- Bundled docs: `C:\Users\DenTeach\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\`

### Uninstall

```powershell
npm uninstall -g @earendil-works/pi-coding-agent
```

Uninstalling Pi **does not** remove `~/.pi/agent/` (settings, auth, sessions, extensions).

---

## Directory Layout (This Machine)

### Global Pi config (`~/.pi/agent/`)

| Path | Purpose |
|------|---------|
| `C:\Users\DenTeach\.pi\agent\settings.json` | Global settings (theme, default model, etc.) |
| `C:\Users\DenTeach\.pi\agent\auth.json` | Stored API keys and OAuth tokens (`0600` permissions) |
| `C:\Users\DenTeach\.pi\agent\extensions\` | Global extensions (auto-discovered) |
| `C:\Users\DenTeach\.pi\agent\sessions\` | Session history files |
| `C:\Users\DenTeach\.pi\agent\bin\` | Pi-managed binaries |
| `C:\Users\DenTeach\.pi\agent\npm\` | Installed npm pi packages |
| `C:\Users\DenTeach\.pi\agent\git\` | Installed git pi packages |
| `C:\Users\DenTeach\.pi\agent\trust.json` | Project trust decisions |

### Project-local config (`.pi/` in a project)

| Path | Purpose |
|------|---------|
| `.pi/settings.json` | Project settings (overrides global) |
| `.pi/extensions/` | Project-only extensions |
| `.pi/npm/` | Project-installed npm packages |
| `.pi/git/` | Project-installed git packages |

Project-local resources load only after the project is **trusted** (interactive prompt on first visit, or `--approve` / `defaultProjectTrust`).

### Current global settings (this machine)

```json
{
  "lastChangelogVersion": "0.80.3",
  "theme": "dark",
  "defaultProvider": "cursor",
  "defaultModel": "composer-2.5",
  "defaultThinkingLevel": "medium"
}
```

---

## Authentication

### `/login` flow (interactive)

```
/login
  → "Use a subscription"     (OAuth providers)
  → "Use an API key"         (API-key providers)
    → pick provider
      → enter key / run OAuth flow
```

`/logout` removes credentials **stored in auth.json only**. Environment variables and `models.json` config are unchanged.

### Built-in subscription providers (OAuth)

- ChatGPT Plus/Pro (OpenAI Codex)
- Claude Pro/Max (Anthropic)
- GitHub Copilot

### Built-in API key providers

Set via `/login` or environment variable. Examples:

| Provider | Env var |
|----------|---------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

Full list: `docs/providers.md` in the installed package.

### Credential resolution order

1. CLI `--api-key` flag (runtime override)
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`

**auth.json takes priority over environment variables.**

### auth.json format

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openai": { "type": "oauth", "access": "...", "refresh": "...", "expires": 1234567890 }
}
```

Key field syntax:
- `"!command"` — execute shell command, use stdout as key
- `"$ENV_VAR"` / `"${ENV_VAR}"` — env interpolation
- `"$$"` — literal `$`
- Plain string — literal API key

### Which providers appear in `/login`?

- **OAuth providers**: registered via `pi.registerProvider(..., { oauth: {...} })` in extensions
- **API key providers**: built-in providers + custom providers **without** oauth registration

If a provider has `oauth` configured, it appears under **"Use a subscription"**, not "Use an API key".

### Models visibility

- `pi --list-models` shows only models with **configured auth**
- Models are registered at startup by extensions/providers even without auth, but hidden until logged in

---

## Extension vs Package

These are **not** peer concepts — a package *contains* extensions (and other resources).

| Aspect | Extension | Package |
|--------|-----------|---------|
| What it is | One piece of functionality (code) | Shareable bundle |
| Stand alone? | Yes — drop a `.ts` file in place | Yes — `pi install` unit |
| Contents | Just itself | 0+ extensions, skills, prompts, themes |
| Global location | `~/.pi/agent/extensions/` | `~/.pi/agent/npm/` or `git/...` |
| Project location | `.pi/extensions/` | `.pi/npm/` or `.pi/git/...` |

**Mental model:** one script adding one feature = extension. A versioned collection you publish/share = package.

### Package structure

```
my-pi-package/
├── package.json          # declares resources under "pi" key
├── extensions/           # .ts / .js modules
├── skills/               # SKILL.md folders (recursive)
├── prompts/              # .md prompt templates
└── themes/               # .json themes
```

### Install packages

```bash
pi install npm:@foo/pi-tools
pi install git:github.com/user/repo@v1
pi install /absolute/path/to/package
pi install ./relative/path

pi list
pi remove npm:@foo/pi-tools
pi update --all
```

Try without installing:

```bash
pi -e npm:@foo/pi-tools
pi -e ./my-extension.ts
```

---

## Writing Extensions

Extensions are **TypeScript modules** loaded via [jiti](https://github.com/unjs/jiti) — no compilation step required.

> **Security:** Extensions run with full system permissions. Only install code you trust.

### Extension locations (auto-discovered)

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | Global |
| `~/.pi/agent/extensions/my-ext/index.ts` | Global (subdirectory) |
| `.pi/extensions/*.ts` | Project-local |
| `.pi/extensions/my-ext/index.ts` | Project-local |

Additional paths in `settings.json`:

```json
{
  "extensions": [
    "/path/to/extension.ts",
    "/path/to/extension/dir"
  ],
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ]
}
```

### Three extension file structures

1. **Single file:** `~/.pi/agent/extensions/my-extension.ts`
2. **Directory with index:** `~/.pi/agent/extensions/my-extension/index.ts`
3. **With npm deps:** same directory + `package.json` + `npm install`

### Minimal extension template

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });

  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });
}
```

### Async factory (for startup I/O)

```typescript
export default async function (pi: ExtensionAPI) {
  const models = await fetchModelsFromSomewhere();
  pi.registerProvider("my-provider", { models, ... });
}
```

Pi **awaits** async factories before startup continues — providers registered here are available immediately and to `pi --list-models`.

### Available imports (bundled with Pi)

| Package | Purpose |
|---------|---------|
| `@earendil-works/pi-coding-agent` | `ExtensionAPI`, events, types |
| `@earendil-works/pi-ai` / `compat` | AI types, streaming utilities |
| `@earendil-works/pi-ai/oauth` | OAuth types |
| `@earendil-works/pi-tui` | TUI components |
| `typebox` | Tool parameter schemas |
| `node:fs`, `node:path`, `node:child_process`, etc. | Node built-ins |

npm dependencies in extension `package.json` also work after `npm install`.

### Test and reload

```bash
# One-off test
pi -e ./my-extension.ts

# Permanent install
copy my-extension.ts %USERPROFILE%\.pi\agent\extensions\

# Hot reload after edits (interactive mode)
/reload
```

---

## Extension API Overview

### `pi.on(event, handler)` — lifecycle hooks

**Resource events:**
- `resources_discover` — provide extra skill/prompt/theme paths
- `project_trust` — custom trust prompt logic

**Session events:**
- `session_start`, `session_shutdown`
- `session_before_switch`, `session_before_fork`
- `session_before_compact`, `session_compact`
- `session_before_tree`, `session_tree`

**Agent events:**
- `before_agent_start` — modify system prompt / inject messages
- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `context` — modify messages before LLM call
- `before_provider_request`, `after_provider_response`

**Tool events:**
- `tool_call` — block or mutate args (`event.input` is mutable in place)
- `tool_result` — modify results
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`

**User input:**
- `input` — intercept/transform user input
- `user_bash` — intercept `!command` bash execution

**Model events:**
- `model_select`, `thinking_level_select`

Handlers can return results to block, modify, or cancel operations. See `docs/extensions.md` for full event reference.

### `pi.registerTool()` — LLM-callable tools

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What the LLM sees",
  parameters: Type.Object({ ... }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return { content: [{ type: "text", text: "result" }], details: {} };
  },
});
```

### `pi.registerCommand()` — slash commands

```typescript
pi.registerCommand("deploy", {
  description: "Deploy the app",
  handler: async (args, ctx) => { ... },
});
```

### `pi.registerProvider()` — custom model providers

See [Custom Providers](#custom-providers) below.

### `pi.registerShortcut()`, `pi.registerFlag()`, `pi.registerMessageRenderer()`

Register keyboard shortcuts, CLI flags, and custom message renderers.

### `ctx.ui` — user interaction (TUI mode)

```typescript
await ctx.ui.select("Title", ["a", "b", "c"]);
await ctx.ui.confirm("Title", "Are you sure?");
await ctx.ui.input("Title", "placeholder");
ctx.ui.notify("message", "info" | "warning" | "error");
ctx.ui.setStatus("key", "footer text");
ctx.ui.setWidget("key", ["line1", "line2"]);
await ctx.ui.custom(factory);  // full custom TUI component
```

### `ctx` in commands (extra capabilities)

`ExtensionCommandContext` adds: `waitForIdle()`, `newSession()`, `fork()`, `navigateTree()`, `switchSession()`, `reload()`.

### State persistence

```typescript
pi.appendEntry("my-state", { todos: [...] });  // saved in session file, not sent to LLM
pi.setSessionName("feature-x");
pi.setLabel(entryId, "checkpoint");
```

---

## Custom Providers

Register via `pi.registerProvider(name, config)` in an extension.

### Override existing provider (proxy)

```typescript
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com",
  headers: { "X-Custom": "value" }
});
```

When only `baseUrl`/`headers` are set (no `models`), existing models are preserved with the new endpoint.

### Register new provider

```typescript
pi.registerProvider("my-llm", {
  name: "My LLM",
  baseUrl: "https://api.example.com/v1",
  apiKey: "$MY_LLM_API_KEY",
  api: "openai-completions",
  models: [{
    id: "my-model",
    name: "My Model",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }],
});
```

When `models` is provided, it **replaces** all existing models for that provider.

### API types (`api` field)

| API | Use for |
|-----|---------|
| `anthropic-messages` | Anthropic Claude and compatibles |
| `openai-completions` | OpenAI Chat Completions and compatibles |
| `openai-responses` | OpenAI Responses API |
| `openai-codex-responses` | OpenAI Codex Responses |
| `google-generative-ai` | Google Gemini |
| `google-vertex` | Google Vertex AI |
| `bedrock-converse-stream` | Amazon Bedrock |
| `mistral-conversations` | Mistral |
| Custom string + `streamSimple` | Non-standard APIs |

### OAuth provider (shows in `/login` → subscription)

```typescript
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

pi.registerProvider("my-corp", {
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI",
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      callbacks.onAuth({ url: "https://sso.corp.com/authorize?..." });
      const code = await callbacks.onPrompt({ message: "Paste callback URL:" });
      // exchange code for tokens...
      return { access: "...", refresh: "...", expires: Date.now() + 3600000 };
    },
    async refreshToken(credentials) { /* refresh */ return credentials; },
    getApiKey(credentials) { return credentials.access; },
  },
});
```

**OAuthLoginCallbacks:**
- `onAuth({ url })` — show URL for browser OAuth
- `onDeviceCode({ userCode, verificationUri, ... })` — device code flow
- `onPrompt({ message })` — text input
- `onSelect({ message, options })` — pick from list
- `onProgress?(message)` — status updates

### Custom streaming (`streamSimple`)

For APIs that don't match built-in types, implement your own stream handler:

```typescript
import {
  createAssistantMessageEventStream,
  calculateCost,
} from "@earendil-works/pi-ai/compat";

function streamMyProvider(model, context, options) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output = { role: "assistant", content: [], ... };
    stream.push({ type: "start", partial: output });
    // push text_delta, thinking_delta, toolcall_* events...
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
  })();
  return stream;
}

pi.registerProvider("my-provider", {
  api: "my-custom-api",
  models: [...],
  streamSimple: streamMyProvider,
});
```

Event protocol: `start` → partial updates (`text_delta`, etc.) → `done` or `error`.

### Unregister

```typescript
pi.unregisterProvider("my-llm");  // immediate, no /reload needed
```

### Example extensions in the installed package

```
node_modules/@earendil-works/pi-coding-agent/examples/extensions/
├── custom-provider-anthropic/    # custom stream + OAuth
├── custom-provider-gitlab-duo/   # proxy + OAuth + streamSimple
├── permission-gate.ts
├── todo.ts
├── snake.ts
└── ... (80+ examples)
```

---

## Cursor Provider Extension (This Machine)

**File:** `C:\Users\DenTeach\.pi\agent\extensions\cursor\index.ts`

Hand-rolled extension (no downloaded packages) that adds **Cursor** as a Pi model provider.

### What it does

- Registers provider id `cursor` named **Cursor**
- Discovers ~150 models via `agent models` (Cursor Agent CLI)
- Routes LLM calls through the **Cursor Agent CLI** (`agent -p ... --output-format stream-json`)
- Supports two auth modes:

| Mode | How | `/login` path |
|------|-----|---------------|
| **Host session** | Uses Cursor app / `agent login` on this machine | Subscription → Cursor → "Cursor app / CLI login" |
| **API key** | Dashboard key from cursor.com | Subscription → Cursor → "Cursor API key" |

### Host credential behavior

- Cursor app stores auth at `%APPDATA%\Cursor\auth.json` (`accessToken`, `refreshToken`)
- Cursor CLI (`agent status`) reports: `Logged in as <email>`
- The app access token **cannot** be passed as `--api-key` to the CLI (invalid)
- Host auth works by **omitting** `--api-key` so the CLI uses its stored session
- Extension stores a sentinel `__cursor_host_session__` in Pi's `auth.json`
- On startup, if host is logged in and Pi has no `cursor` entry, extension auto-writes host auth to disk

### Windows-specific: spawning `agent`

On Windows, `agent` is a wrapper at:
```
%LOCALAPPDATA%\cursor-agent\agent.cmd
%LOCALAPPDATA%\cursor-agent\versions\<version>\node.exe
%LOCALAPPDATA%\cursor-agent\versions\<version>\index.js
```

The extension resolves the `node.exe` + `index.js` path directly to avoid shell quoting issues. Override with:
- `CURSOR_AGENT_PATH`
- `AGENT_PATH`

### Environment variables

| Variable | Purpose |
|----------|---------|
| `CURSOR_API_KEY` | Dashboard API key (also supported via `/login`) |
| `CURSOR_AGENT_PATH` | Path to Cursor Agent CLI binary |

### Usage

```powershell
# If already logged into Cursor app / agent CLI, models appear after first pi run
pi
/login          # optional — pick host or API key
/model cursor/composer-2.5
```

```powershell
pi --list-models cursor    # after auth is configured
```

### Cursor Cloud Agents API (reference)

Separate from the CLI integration:
- Base URL: `https://api.cursor.com`
- Auth: Basic (`-u API_KEY:`) or Bearer
- Endpoints: `/v1/agents`, `/v1/models`, etc.
- Docs: https://cursor.com/docs/cloud-agent/api/endpoints

The extension uses the **Agent CLI**, not the Cloud Agents REST API directly, because Pi needs streaming chat completions and the CLI already handles Cursor auth.

---

## Settings Reference

Global: `~/.pi/agent/settings.json`  
Project: `.pi/settings.json` (overrides global)

Common settings:

| Setting | Description |
|---------|-------------|
| `defaultProvider` | e.g. `"anthropic"`, `"cursor"` |
| `defaultModel` | Model ID |
| `defaultThinkingLevel` | `"off"` … `"xhigh"` |
| `theme` | `"dark"`, `"light"`, or custom |
| `packages` | Installed pi packages |
| `extensions` | Extra extension paths |
| `compaction.enabled` | Auto-summarize on context overflow |
| `defaultProjectTrust` | `"ask"`, `"always"`, `"never"` |

Edit via `/settings` in interactive mode or directly in JSON.

---

## Useful CLI Commands

```bash
pi                          # interactive TUI
pi -p "prompt"              # print mode (non-interactive)
pi --list-models            # list models with configured auth
pi --list-models cursor     # filter by provider
pi --provider anthropic --model claude-sonnet-4-6
pi -e ./extension.ts        # load extension for one run
pi --no-extensions          # disable extensions
pi --offline                # disable network on startup
pi install npm:@foo/bar
pi /reload                  # hot-reload extensions (interactive)
```

### Built-in slash commands (selection)

| Command | Purpose |
|---------|---------|
| `/login` | Configure provider auth |
| `/logout` | Remove stored credentials |
| `/model` | Switch model |
| `/settings` | Open settings |
| `/reload` | Reload extensions, skills, prompts, themes |
| `/compact` | Manually compact context |
| `/tree` | Navigate session tree |
| `/fork` | Fork session at point |

---

## Modes

| Mode | Description |
|------|-------------|
| Interactive TUI | Default — full terminal UI |
| Print (`-p`) | Non-interactive, stdout output |
| JSON (`--mode json`) | Structured JSON output |
| RPC (`--mode rpc`) | Machine-readable RPC protocol |

`ctx.ui` dialogs are only available in TUI and RPC modes (`ctx.hasUI`).

---

## Pi Monorepo (for contributing / reading source)

```
packages/
  ai/            # LLM provider abstraction (@earendil-works/pi-ai)
  agent/         # Agent loop and message types (@earendil-works/pi-agent-core)
  tui/           # Terminal UI (@earendil-works/pi-tui)
  coding-agent/  # CLI and interactive mode (@earendil-works/pi-coding-agent)
```

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono && npm install && npm run build
./pi-test.sh   # run from source
```

Installed package source on this machine:
```
C:\Users\DenTeach\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\
```

Key internal files:
- `dist/core/extensions/types.d.ts` — ExtensionAPI types
- `dist/core/extensions/loader.js` — jiti loader, virtual modules
- `dist/core/model-registry.js` — provider registration
- `dist/core/auth-storage.js` — auth.json management
- `dist/modes/interactive/interactive-mode.js` — `/login` UI logic
- `docs/extensions.md` — full extension reference
- `docs/custom-provider.md` — provider development guide
- `examples/extensions/` — 80+ working examples

---

## Windows Notes

- Pi global config uses `%USERPROFILE%\.pi\agent\` (same as `~/.pi/agent/`)
- Cursor Agent CLI installs to `%LOCALAPPDATA%\cursor-agent\`
- Cursor IDE auth: `%APPDATA%\Cursor\auth.json`
- Default external editor on Windows: Notepad (override in `settings.json`)
- Extension `spawn()` of CLI tools: prefer direct `node.exe` paths over `shell: true` on Windows
- Invalid `CURSOR_API_KEY` env var breaks `agent models` — unset it during model discovery

---

## Development Tips

1. **Start from examples** — copy from `examples/extensions/` in the installed package
2. **Use `-e` for fast iteration** — `pi -e ./my-ext.ts` before installing globally
3. **Use `/reload`** — after placing in `~/.pi/agent/extensions/`
4. **Async factory for I/O** — model discovery, remote config fetch
5. **OAuth for `/login`** — only way to add custom providers to the subscription menu
6. **streamSimple for weird APIs** — when no built-in `api` type fits
7. **session_start for bootstrapping** — access `ctx.modelRegistry.authStorage` to set credentials
8. **Never read secrets into docs/logs** — auth.json contains live tokens

---

## Open Questions (not fully verified)

- Exact schema of the `"pi"` key inside package `package.json` — see https://pi.dev/docs/latest/packages
- Exact syntax of `settings.json` `"extensions"` array entries beyond path strings
- Precedence when global and project-local define the same extension/provider name

---

## Quick Links

| Resource | URL |
|----------|-----|
| Pi docs | https://pi.dev/docs/latest |
| Extensions docs | https://pi.dev/docs/latest/extensions |
| Packages docs | https://pi.dev/docs/latest/packages |
| GitHub | https://github.com/earendil-works/pi |
| Cursor CLI docs | https://cursor.com/docs/cli/overview |
| Cursor Cloud API | https://cursor.com/docs/cloud-agent/api/endpoints |
| Installed Pi docs (local) | `%AppData%\npm\node_modules\@earendil-works\pi-coding-agent\docs\` |

---

## File Index (this setup)

| File | Role |
|------|------|
| `C:\Users\DenTeach\.pi\agent\extensions\cursor\index.ts` | Custom Cursor provider extension |
| `C:\Users\DenTeach\.pi\agent\settings.json` | Global Pi settings |
| `C:\Users\DenTeach\.pi\agent\auth.json` | Stored credentials |
| `C:\Users\DenTeach\Desktop\pi agent.txt` | Original research notes |
| `C:\Users\DenTeach\Desktop\pi-agent-setup.md` | This guide |
