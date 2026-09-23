# TypeScript and JavaScript SDK Adapter

Summary: verify the installed SDK generation before selecting imports, schema
helpers, transport adapters, or handler signatures. This is an optional adapter,
not a mandate to use Node, TypeScript, npm, Express, or Zod.

Maintenance notice: substantially rewritten; see `../LICENSE.txt`.

## Identify the actual API

Inspect the package manifest, lockfile, export maps, installed types, and project
tests. Read the matching SDK release documentation. The official repository's
[README](https://github.com/modelcontextprotocol/typescript-sdk) and
[v1-to-v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
are discovery sources, not proof that the same API is installed locally.

Useful generation landmarks from the migration guide:

| Concern | v1 family | v2 family |
| --- | --- | --- |
| Distribution | `@modelcontextprotocol/sdk` | Split `@modelcontextprotocol/server`, `/client`, and optional `/core` packages |
| Server API | `McpServer` via the SDK's server subpath | `McpServer` from the server package |
| stdio | SDK `server/stdio.js` subpath | `@modelcontextprotocol/server/stdio` |
| HTTP adapter | SDK transport selected for the runtime | Runtime-neutral server surface or explicit Node/framework adapter |
| Raw schema constants | SDK types module | Public `@modelcontextprotocol/core` package |

Do not import private `core-internal` modules. Do not combine generations'
transport/server objects or copy old deep imports into split packages. A v2
package number does not establish support for the modern MCP protocol: inspect
its supported revisions and exercise them with the intended client.

Check runtime minimums, ESM/CommonJS exports, peer dependencies, and validation
library versions against the actual release. Use the repository's package
manager and lockfile. Do not install `latest`, run a codemod, or change the
module system just to make a copied example compile.

## Implement with the project's boundaries

1. Construct the server using the verified public constructor and identity
   fields. Keep domain services and the upstream client injectable for tests.
2. Register one tool through the release's documented registration API. Verify
   whether its schema input expects a raw property shape, an object schema, or a
   supported standard-schema adapter; these are not interchangeable.
3. Validate the generated JSON Schema, not just the TypeScript type. Runtime
   strings, nullability, unknown fields, and numeric limits need actual checks.
4. In the handler, use its verified request context for principal, deadline, and
   cancellation. Do not read HTTP-only context unconditionally in stdio.
5. Map domain results to `content`, optional `structuredContent`, and `isError`.
   Use the SDK's documented protocol error types for protocol failures.
6. Attach a transport appropriate to the runtime. A Node `IncomingMessage` /
   `ServerResponse` handler is not a Web `Request` / `Response` handler. Edge
   runtimes may not offer subprocesses or stdio at all.
7. Connect shutdown/abort handling to upstream requests and owned resources.
   Avoid global per-user state and leaving background promises unobserved.

For resources and prompts, verify `registerResource` / `registerPrompt` (or the
release's equivalents), URI template expansion, argument validation, and async
handler return types. Advertise change notifications only when the corresponding
subscription/lifecycle path is implemented and tested.

## Verification recipe

Use existing project scripts rather than assume `npm run build` exists:

- Type-check and build with the repository's configured compiler/module target.
- Run a deterministic in-process client/server test if that release provides an
  in-memory transport. Use both ends from one compatible implementation.
- Spawn the built entry point through a real stdio client; assert stdout purity,
  discovery, a valid call, invalid arguments, upstream failure, and clean exit.
- For HTTP, call the actual mounted route with a compatible client. Test missing,
  invalid, expired, and wrong-audience tokens plus an invalid Origin. Validate
  cancellation and proxy behavior for the supported protocol revision.
- Assert serialized schemas/results and error classification. Type checking alone
  does not establish a correct wire contract.

If the runtime, dependencies, or target client are missing, record the exact
remaining checks. Provide project-native run instructions without claiming an
untested generic example is production-ready.
