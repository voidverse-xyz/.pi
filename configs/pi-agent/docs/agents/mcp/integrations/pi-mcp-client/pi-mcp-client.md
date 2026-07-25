# Pi local stdio MCP client

## Purpose

`configs/pi-agent/packages/pi-mcp-client/` adds a generic local MCP tools bridge to Pi. It launches multiple machine-configured stdio servers, discovers their tools, and registers bounded namespaced Pi tools without adding an MCP dependency to the portable local-path package.

The first release intentionally excludes remote HTTP, resources, prompts, roots, sampling, elicitation, and MCP tasks. Those features have different authorization and lifecycle requirements and should not be implied by a tools-only client.

## Verified contracts

Implementation was checked against:

- Pi dynamic registration: `/opt/pi/docs/extensions.md:1335-1341`.
- Pi session resource lifecycle: `/opt/pi/docs/extensions.md:221-224`, `392-432`, and `507-514`.
- Pi dynamic tool exposure: `/opt/pi/docs/extensions.md:2298-2310`.
- Pi package dependency behavior: `/opt/pi/docs/packages.md:156-177`.
- MCP lifecycle and shutdown: <https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle>.
- MCP stdio framing: <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio>.
- MCP tools and security: <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>.
- MCP cancellation and ping: <https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation> and <https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping>.
- Production MCP TypeScript SDK compatibility versions and stdio behavior: `v1.x` source in the official `modelcontextprotocol/typescript-sdk` repository.

Pi 0.81 permits `registerTool()` during `session_start`, immediately refreshes the tool registry, and requires long-lived processes to start only after a session exists and close idempotently in `session_shutdown`.

## Package structure

```text
pi-mcp-client/
├── extensions/mcp-client/
│   ├── config.ts
│   ├── index.ts
│   ├── protocol.ts
│   └── tools.ts
├── test/
│   ├── fixtures/
│   ├── config.test.ts
│   ├── protocol.test.ts
│   ├── rpc.test.mjs
│   └── tools.test.ts
├── package.json
└── README.md
```

## Configuration contract

The extension reads `mcp.json` from Pi's agent directory, or an absolute path selected by `PI_MCP_CONFIG`. The file is bounded, versioned, machine-local, and must not be committed.

Each enabled server has:

- a direct executable and argument array;
- an absolute working directory, defaulting to the agent directory instead of the active project;
- environment mappings from child variable names to existing parent variable names;
- explicit confirmation, restart, startup-timeout, and call-timeout policy.

No literal credential field exists. The child inherits only the small environment set used by the production MCP SDK plus explicitly mapped variables.

## Lifecycle

1. `session_start` tears down stale state, reads config, and creates one client per enabled server.
2. Each client directly spawns its server with `shell: false` and strict newline-delimited JSON-RPC framing.
3. The client sends `initialize`, validates the negotiated stable version and server metadata, then sends `notifications/initialized`.
4. `tools/list` is paginated and capped. Invalid, oversized, duplicate, or required-task tools are skipped.
5. Remote tools receive deterministic `mcp_<server>_<tool>` names with stable collision hashes.
6. Small catalogs are active immediately. Large catalogs keep remote tools registered but inactive behind `mcp_search_tools`.
7. Calls optionally confirm, forward through `tools/call`, honor abort/timeout cancellation, bound output, and label MCP results as untrusted.
8. `session_shutdown` closes stdin, waits, escalates through TERM and KILL, rejects pending requests, and waits for cleanup.

A disconnected server restarts lazily on the next tool call when configured. `notifications/tools/list_changed` marks the server stale and asks for `/reload`; schemas are not silently replaced mid-conversation.

## Security decisions

- MCP servers remain arbitrary local code with the user's full OS permissions; the client does not claim sandboxing.
- Confirmation defaults to every call and fails closed when UI is unavailable.
- `confirm: "never"` is an explicit per-server trust grant, never inferred from untrusted MCP annotations.
- The client declares no roots, sampling, elicitation, or task capabilities and answers only server `ping` requests.
- Server instructions are retained only as protocol input and are never injected into Pi.
- Stderr is drained but not copied into model/session output.
- Config, protocol frames, catalogs, schema sizes, output text, images, and structured details are bounded.
- One server's startup failure does not block other configured servers.
- Tool descriptions and outputs remain untrusted model context; confirmation protects execution but does not sanitize server behavior.

## Progressive discovery

The config has both a tool-count threshold and serialized schema-size threshold. When either is exceeded, `mcp_search_tools` performs deterministic keyword scoring across server id, remote name, Pi name, title, and description. Selected definitions are activated additively through Pi's supported dynamic-tool flow.

This avoids placing a large MCP catalog into every model request while retaining normal direct Pi tool calls after discovery.

## Verification targets

Automated coverage includes:

- config defaults, bounds, invalid roots, server skipping, environment-name mappings, and absolute overrides;
- stdio initialization, version negotiation, pagination, server ping, cancellation, malformed records, list-change notifications, and graceful shutdown;
- schema validation, required-task rejection, deterministic names, collision handling, redaction, output conversion, and truncation;
- installed Pi RPC registration for both eager and progressive catalogs;
- the repository-wide package regression suite.

## Known limitations

- Local stdio only; no Streamable HTTP or OAuth.
- Tools only; no MCP resources or prompts.
- Required task execution is rejected.
- Arbitrary output schemas are bounded but not independently validated without a JSON Schema runtime dependency.
- Tool-list changes require `/reload` so the model never receives silently changed schemas during an active conversation.
