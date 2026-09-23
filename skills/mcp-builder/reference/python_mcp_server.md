# Python SDK Adapter

Summary: distinguish the official SDK's versions from the separately distributed
FastMCP project. Follow the installed distribution's documented public API; do
not mix decorators, contexts, transports, or model types across them.

Maintenance notice: substantially rewritten; see `../LICENSE.txt`.

## Identify the distribution and generation

Inspect project metadata, lockfiles, interpreter requirements, installed package
metadata, and existing tests. An import name alone does not establish the package
version or supported protocol revisions.

The official SDK's [README](https://github.com/modelcontextprotocol/python-sdk)
and [migration guide](https://github.com/modelcontextprotocol/python-sdk/blob/main/docs/migration.md)
describe these generation landmarks:

| Distribution/API family | High-level server landmark | Caution |
| --- | --- | --- |
| Official `mcp` v1 | `from mcp.server.fastmcp import FastMCP` | Legacy SDK examples and initialization lifecycle |
| Official `mcp` v2 | `from mcp.server.mcpserver import MCPServer` | Renamed API, context and transport changes; verify exact release |
| Standalone `fastmcp` | Commonly `from fastmcp import FastMCP` | Separate project with its own versions, dependencies, and documentation |

These are version-identification clues, not instructions to upgrade. Verify the
release's supported-version definitions and installed API. Rolling `main` docs
may describe APIs not in the installed release. Follow the standalone project's
own docs when that is the selected dependency.

The official v2 migration also changes public model attributes to snake_case
(for example, `structured_content`, `is_error`, and `next_cursor`), while the MCP
wire format retains its specified names. Use the SDK's supported serialization
with wire aliases; do not `json.dumps()` arbitrary Pydantic/content objects or
assume attribute names equal JSON keys. Client APIs, HTTP dependencies, error
classes, and high-/low-level handler behavior also change across generations.

## Implement with explicit ownership

1. Use the repository's environment/lock tooling and detected interpreter. Do
   not assume `python`, `python3`, or a platform-specific launcher exists. No
   global install or new package manager is required by this guide.
2. Construct the selected server with the documented identity and lifecycle
   parameters. Keep transport configuration in the location required by that
   release; constructor and run/app parameters are not stable across versions.
3. Register a typed tool using the verified decorator/registration API. Define
   input constraints and inspect the emitted schema, including default/nullable
   behavior and conversion of validation errors.
4. Use asynchronous upstream I/O with bounded concurrency. Do not block the event
   loop with synchronous HTTP calls. Check whether synchronous handlers execute
   in a worker thread before using event-loop-local state in them.
5. Create shared upstream clients through the server's lifespan/context support
   and close them deterministically. Keep user/tenant authorization request-local.
6. Return the release's documented tool result or supported conversion type.
   Verify automatic schema generation and result wrapping rather than assuming
   a dictionary or bare list always becomes the intended MCP result.
7. Preserve cancellation exceptions and close resources in context managers or
   `finally` blocks. Use the project's async backend and SDK-compatible client
   types instead of mixing incompatible event loops or HTTP implementations.

High-level tool decorators and low-level handlers can map exceptions differently.
Test domain failures and protocol failures separately. Do not copy a blanket
exception-to-`isError` wrapper from one API generation into another.

For optional client interaction, verify modern multi round-trip helpers versus
legacy back-channel calls. A method still present in the SDK can be unusable for
the selected protocol context. Decline, cancellation, and unsupported capability
must be exercised, not just a successful elicitation example.

## Verification recipe

Run the repository's existing formatter, type checker, and tests when available.
A syntax check is useful but does not prove imports resolve, dependencies match,
tools register, schemas validate, or the protocol works.

- Import/register the server in the locked environment without external calls.
- Exercise success, empty result, invalid arguments, unauthorized access, and
  upstream failure using deterministic fixtures.
- Assert serialized field names, content blocks, structured output, and errors.
- Use a compatible client over real stdio or HTTP, not just direct Python calls.
- Check timeout/cancellation propagation, concurrent tenant isolation, startup
  failure, and graceful cleanup.
- For migrations, run both the targeted protocol matrix and legacy consumers
  still promised support; verify absence of accidental deprecated back-channel
  usage on modern requests.

Document missing interpreter/client capabilities honestly and leave reproducible
project-native checks. Do not install a paid-provider evaluator or require a
browser merely to verify a Python MCP server.
