# pi-mcp-client

Adds local Model Context Protocol (MCP) tools to Pi. The extension launches configured
stdio servers as child processes, negotiates MCP, discovers `tools/list`, and registers
each accepted server tool as a namespaced Pi tool.

This package intentionally supports the local stdio transport and MCP tools only. It
does not connect to remote HTTP servers or expose MCP resources, prompts, roots,
sampling, elicitation, or task-based tool execution.

## Configuration

Create `mcp.json` in Pi's agent directory, normally `~/.pi/agent/mcp.json`. Keep
this machine-local file out of commits and store credentials only in the environment.
`PI_MCP_CONFIG` may point to a different absolute configuration path.

```json
{
  "version": 1,
  "eagerToolLimit": 24,
  "eagerSchemaBytes": 32768,
  "servers": {
    "example": {
      "command": "node",
      "args": ["<absolute-server-root>/dist/index.js"],
      "cwd": "<absolute-server-root>",
      "env": {
        "SERVICE_TOKEN": "SOURCE_SERVICE_TOKEN"
      },
      "confirm": "always",
      "autoRestart": true,
      "startupTimeoutMs": 15000,
      "callTimeoutMs": 120000
    }
  }
}
```

Replace the placeholder paths with absolute paths. The command is executed directly,
without a shell. If `cwd` is omitted, the agent directory is used rather than the
current project.

`env` maps each child-process variable to the name of an existing Pi-process variable.
The example passes the value of `SOURCE_SERVICE_TOKEN` to the server as
`SERVICE_TOKEN`; it does not store the credential in JSON. Missing mapped variables
make that server fail closed.

Server options:

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Set `false` to skip the server. |
| `args` | `[]` | Direct executable arguments; no shell parsing. |
| `cwd` | agent directory | Absolute child working directory. |
| `env` | `{}` | Child-variable to parent-variable name mappings. |
| `confirm` | `"always"` | Confirm every tool call. `"never"` is an explicit trust grant. |
| `autoRestart` | `true` | Restart a disconnected server when one of its registered tools is called. |
| `startupTimeoutMs` | `15000` | Per-request initialization and discovery timeout. |
| `callTimeoutMs` | `120000` | Tool-call timeout before MCP cancellation. |

Use `/mcp` or `/mcp status` to inspect the selected config, connections, warnings,
and discovered tool count. Change configuration by editing the file and running
`/reload`; the extension does not write credentials or server settings.

## Tool exposure

Remote names are converted to deterministic Pi names such as
`mcp_example_lookup_issue`. Names that require normalization or collision avoidance
receive a stable hash suffix.

Small catalogs are exposed eagerly. If the catalog exceeds either
`eagerToolLimit` or `eagerSchemaBytes`, only `mcp_search_tools` is active initially.
The model uses it to search the cached catalog and add matching definitions through
Pi's dynamic-tool mechanism.

A server that sends `notifications/tools/list_changed` is marked stale. Run `/reload`
before using changed schemas; the extension does not silently replace a tool schema
mid-conversation.

## Lifecycle and protocol

Each Pi session:

1. Reads and validates the bounded machine-local configuration.
2. Launches enabled servers concurrently with a minimal inherited environment.
3. Negotiates the latest stable MCP version and accepts the compatibility versions
   supported by the production MCP TypeScript SDK.
4. Sends `notifications/initialized`, paginates `tools/list`, validates and bounds
   definitions, then registers Pi tools.
5. Forwards calls through `tools/call`, including Pi cancellation and timeouts.
6. Closes stdin, waits, sends `SIGTERM`, and finally sends `SIGKILL` during
   `session_shutdown` when needed.

The implementation supports server-initiated MCP `ping` requests and rejects every
other server request because no roots, sampling, elicitation, or task capabilities are
declared. Stderr is drained to prevent child-process deadlock but is not returned to
the model or copied into session output.

## Security boundary

An MCP server is executable code running with the Pi user's operating-system and
network privileges. This extension does not sandbox it. Review every server command
and use an OS sandbox or container when filesystem or network isolation is required.

Additional controls:

- direct spawn with `shell: false`;
- minimal inherited environment plus explicit variable mappings;
- confirmation required by default and fail-closed behavior without interactive UI;
- no server instruction injection into Pi's system prompt;
- no client roots, model sampling, elicitation, or arbitrary server-request handlers;
- bounded config, protocol records, tool catalogs, schemas, text, images, and details;
- MCP tool descriptions, catalogs, and results are labeled or treated as untrusted;
- malformed protocol records, unsupported versions, and invalid schemas fail closed.

`confirm: "never"` should be used only for a server whose code, credentials, tool
semantics, and side effects you trust. MCP annotations are not used to bypass the
confirmation policy.

## Compatibility and limitations

The client implements the stable MCP stdio lifecycle and tools subset directly, without
a third-party runtime dependency. Supported protocol versions are `2025-11-25`,
`2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`.

Output schemas are bounded and retained as metadata, but this dependency-free client
does not independently validate `structuredContent` against arbitrary JSON Schema.
The server remains responsible for protocol-required input and output validation. Tools
with `execution.taskSupport: "required"` are skipped.

## Activation

This package is enabled through the repository's root `settings.json`. Run `/reload`
or restart Pi after changing the package or configuration.

## Verification

```bash
node --experimental-strip-types --test \
  configs/pi-agent/packages/pi-mcp-client/test/*.test.ts \
  configs/pi-agent/packages/pi-mcp-client/test/*.test.mjs
```
