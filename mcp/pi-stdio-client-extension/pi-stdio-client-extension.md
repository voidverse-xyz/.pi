# Pattern: local stdio MCP tools in a Pi extension

Use this pattern when a Pi installation needs tools from trusted local MCP servers without exposing a network listener.

## Architecture

- Keep server definitions in a machine-local, versioned configuration file.
- Start subprocesses only from `session_start`; factories may run without a session.
- Use direct argv-based spawn with `shell: false`.
- Implement strict newline-delimited UTF-8 JSON-RPC framing with a maximum record size.
- Negotiate a supported stable MCP version before any operation other than ping.
- Declare only capabilities the client actually implements.
- Discover with paginated `tools/list`, then register namespaced Pi tools dynamically.
- Forward calls through `tools/call`; translate Pi aborts and timeouts into `notifications/cancelled`.
- Close stdin and escalate through TERM/KILL in idempotent `session_shutdown` cleanup.

## Security baseline

A local MCP server is arbitrary code with the user's OS and network authority. A client wrapper is not a sandbox.

- Require confirmation by default; fail closed when confirmation UI is unavailable.
- Treat `confirm: never` as an explicit trust grant, not something derived from server annotations.
- Inherit a minimal environment and map additional variable names without storing secret values in config.
- Default the subprocess working directory away from the active project.
- Do not offer roots, sampling, elicitation, or other client callbacks unless their authorization model is implemented.
- Ignore server instructions rather than injecting them into the host prompt.
- Bound configuration, frames, pages, tool count, schemas, output, media, and stored details.
- Treat tool descriptions and results as untrusted model context.
- Drain stderr to avoid deadlock, but do not automatically send it to the model or logs.

## Tool mapping

Generate deterministic names such as `mcp_<server>_<tool>`. Normalize unsupported characters and append a stable hash whenever normalization, truncation, or an existing host tool could create a collision. Never silently override another extension's tool.

Pass valid MCP object input schemas to Pi's tool registry. Skip malformed, oversized, duplicate, or required-task definitions. A wrapper should resolve the current server binding at execution time so a disconnected server can restart lazily.

## Large catalogs

For small catalogs, eager registration is simplest. For larger catalogs:

1. Register every definition but keep remote tools inactive.
2. Expose one stable search tool.
3. Search cached names and descriptions deterministically.
4. Activate matching definitions additively with `setActiveTools()`.
5. Mark list-change notifications stale and require reload when safe schema replacement is unavailable.

Use both tool-count and serialized-schema-size thresholds; count alone misses a few extremely large schemas.

## Verification matrix

- Missing, malformed, oversized, and partially invalid config.
- Missing mapped environment variable.
- Spawn failure and unsupported protocol version.
- Malformed/oversized stdout record.
- Paginated and duplicate tool lists.
- Server-initiated ping and unsupported server requests.
- Tool success, MCP execution error, timeout, abort, late response, and process crash.
- Text/media/resource/structured result conversion and truncation.
- Eager and progressive registration in a real Pi RPC smoke test.
- Shutdown of normal and signal-resistant children without orphaning pending requests.
