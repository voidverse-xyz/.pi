# MCP Protocol and Security Guide

Summary: implement the intersection of the selected protocol, SDK, and client
capabilities. Do not combine lifecycle rules from different revisions.

Maintenance notice: substantially rewritten; the package's original license is
retained in `../LICENSE.txt`.

## Protocol compatibility comes first

The official versioning documentation identified `2026-07-28` as current when
this guide was revised. That does not prove any installed SDK or client supports
it. Consult the [versioning overview](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning)
and the target SDK's tagged documentation and supported-version definitions.
Treat rolling `main` documentation as research, not a dependency pin.

| Concern | `2026-07-28` | Legacy `2025-11-25` and earlier |
| --- | --- | --- |
| Version and capabilities | Per-request `_meta` envelope; HTTP also carries `MCP-Protocol-Version` | `initialize` request/response followed by `notifications/initialized` |
| Discovery | Servers implement `server/discover`; clients need not call it before other requests | Initialization exchanges server/client information and capabilities |
| Unsupported revision | `UnsupportedProtocolVersionError` reports supported revisions | Follow that revision's initialization negotiation/failure rules |
| Protocol session | No implicit protocol-level session; explicit application handles can outlive requests | Initialization/session lifecycle; HTTP may use `Mcp-Session-Id` |
| Client-assisted interaction | Multi round-trip requests with `InputRequiredResult`, `inputResponses`, and optional `requestState` | Supported server-to-client requests on the established connection |
| Change notifications | Explicit `subscriptions/listen` streams when supported | Revision-specific notifications and resource subscriptions |

For modern requests, use the SDK to supply the reserved `_meta` keys for
`io.modelcontextprotocol/protocolVersion`, client identity, and client
capabilities. Do not invent envelope fields or manually reuse a legacy handshake
with a modern version string. Validate HTTP header/body consistency as required
by the selected revision. Test both a supported and an unsupported version.

Use the [modern version contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
or the [legacy lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
as appropriate. Support multiple revisions only through a tested adapter/SDK;
do not silently claim compatibility by accepting every date string.

## Schemas, results, and errors

Use JSON Schema semantics from the selected revision and validators supported by
the SDK. Check dialect, required fields, bounds, enums, nullable versus optional
values, and unknown fields. Configure reference resolution so an untrusted schema
cannot trigger arbitrary file/network reads; do not fetch remote `$ref` targets
without a verified, authorized resolution policy.

Tool inputs are objects. Validate tool arguments at the boundary and business
constraints in the domain layer. If an output schema is advertised, return
conforming `structuredContent` and test the serialized result, including empty
and error cases under the target revision's rules. Do not advertise a schema the
SDK cannot represent or validate.

In `2026-07-28`, `structuredContent` may be any JSON value; older revisions/SDKs
may restrict it to objects. An object envelope is often the simplest shared
contract, but do not describe it as a universal current-protocol requirement.
For compatible clients, also return serialized structured data in a text block,
keeping the two representations consistent. Binary/media content must use the
protocol's content types rather than ad hoc JSON serialization of SDK objects.

Example successful tool result (not a complete JSON-RPC response):

```json
{
  "content": [{"type": "text", "text": "{\"items\":[],\"nextCursor\":null}"}],
  "structuredContent": {"items": [], "nextCursor": null},
  "isError": false
}
```

This example's `nextCursor` belongs to the tool's application data, not MCP's
list-method pagination envelope. Define its semantics in the tool output schema.

Separate failure layers:

- Malformed JSON-RPC, unknown methods/tools, and invalid request envelopes use
  the protocol/SDK error mechanism.
- Tool execution failures, including domain validation and upstream failures,
  use tool results with `isError: true` where the target contract specifies it.
  SDK argument-validation behavior varies; test it rather than assuming every
  validation failure becomes the same error category.
- Authentication/transport failures retain meaningful HTTP status and auth
  challenges. Do not convert an unauthenticated request into a successful tool
  response.
- Unexpected faults get redacted public errors and correlated internal logs.
  Do not return stack traces, tokens, raw upstream bodies, or private paths.
- Cancellation remains cancellation, not success, an empty result, or an
  automatically retryable domain error.

Clients/evaluators must preserve content types, structured results, error flags,
and request IDs instead of treating all responses as strings or successful data.
See [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

## Pagination and bounded data

MCP list methods use opaque cursors. Follow `nextCursor` until absent, with an
overall page/item/time limit and repeated-cursor detection. Do not assume the
first page contains every tool, resource, template, or prompt.

Pagination inside a tool is an application contract: specify input cursor and
page-size limits, output continuation fields, stable ordering, and invalid or
expired cursor behavior. Scope cursors to the caller/query; validate any encoded
state. Do not treat possession of a cursor as authorization.

Bound response bytes/items and upstream work. Expose truncation explicitly and
provide a documented continuation or resource reference. Never slice arbitrary
serialized JSON or media bytes and still present the result as valid content.

## Local stdio versus HTTP

### Local stdio

- Let the client own launching and terminating the child process. Supply command,
  argument array, working directory, and only necessary environment variables
  through its supported configuration; avoid shell concatenation.
- stdout contains MCP messages only. Send diagnostics to stderr, including those
  from dependencies and startup code.
- Close upstream clients, streams, and child tasks on EOF, cancellation, or
  shutdown. Test startup failure and paths with spaces on the target OS.
- Grant filesystem and credential access deliberately. A local server executes
  with real local authority; client-provided roots are not a sandbox.

### HTTP

Use the selected revision's Streamable HTTP transport. HTTP+SSE from the older
transport is a compatibility path, not a default for new servers. Streaming SSE
responses within Streamable HTTP are not the same as that deprecated transport.
Choose JSON responses versus streaming based on required capabilities; do not
assume stateless JSON alone supports every notification/interaction flow.

Enforce TLS at the appropriate boundary, authentication on each request,
request/body limits, Origin validation and Host/DNS-rebinding protections.
Reject invalid Origins according to the transport specification. Bind local
listeners to loopback unless external exposure is intentional and secured.
CORS is not authentication. Test proxy buffering, disconnects, and configured
timeouts using the actual deployment path.

For legacy session-based HTTP, scope session identifiers and state to the
principal, expire/clean them up, and verify reconnect/resumption semantics.
A session ID never substitutes for authentication. For modern stateless protocol
requests, keep durable application state behind explicit, authorized handles
with a retention policy; do not rely on connection affinity.

See [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

## Authorization and data boundaries

For an OAuth-protected HTTP deployment, use the selected revision's protected
resource metadata, authorization-server discovery, resource indicators, and
applicable client registration flow. Reuse a maintained OAuth implementation.
Verify issuer, audience/resource binding, signature, expiration, scopes, and
principal/tenant identity. Clients must use the required PKCE and redirect
validation protections for applicable authorization-code flows. Do not pass an
MCP access token through to an upstream service as that service's credential.

Separate MCP access authorization from delegated upstream authorization. Store
upstream secrets securely and bind them to the correct user/tenant. Enforce
object-level permissions on every tool, resource, prompt context fetch, cursor,
and application handle. Avoid cross-user caches and shared mutable request
context. Check authorization again when continuing an interaction.

Treat tool arguments, resources, prompts, upstream content, and elicitation
responses as untrusted data. Constrain filesystem paths after canonicalization,
URL destinations/redirects against SSRF, and subprocess arguments against
injection. Names, descriptions, and `readOnlyHint`/`destructiveHint`/
`idempotentHint`/`openWorldHint` are not security controls.

Explicitly authorize real external calls, mutations, costs, and data transfer.
Read-only operations can still disclose sensitive data. Redact logs and fixtures;
keep secrets out of prompts, URLs, results, transcripts, and source control.
See [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## Optional interactions and deprecations

Check capabilities at the correct revision's scope. Do not require sampling,
elicitation, roots, subscriptions, or background tasks for a simple server.

For modern elicitation, use the SDK's multi round-trip mechanism rather than a
legacy back-channel request. Validate `inputResponses`; treat echoed
`requestState` as attacker-controlled. Protect integrity when state affects
business logic, access, or authority; bind it to the principal and original
operation, expire it, and enforce one-time consumption when needed. Bound the
number of rounds. Perform irreversible side effects only after required inputs
and authorization are settled, with replay/idempotency protection.

Handle accept, decline, cancellation, unsupported capability, and abandoned
interaction. Never infer consent from a timeout or from an echoed state token.
Form elicitation must not collect passwords, API keys, access tokens, or payment
credentials. Use supported secure out-of-band URL interaction for such needs;
validate the target and obtain user consent. URL elicitation is not a replacement
for authorization to the MCP server itself.

The `2026-07-28` registry deprecates roots, sampling, protocol logging, and dynamic
client registration; deprecated does not mean removed. Avoid adopting these in
new modern implementations; retain compatible legacy behavior where required.
Do not replace sampling with a provider call without explicit data-transfer and
cost authorization. Model choice and telemetry remain optional project decisions.

Sources: [multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr),
[elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation),
[deprecations](https://modelcontextprotocol.io/specification/2026-07-28/deprecated).

## Deadlines, cancellation, and shutdown

Set per-call/upstream deadlines and a maximum total duration that progress cannot
extend indefinitely. Propagate cancellation into I/O and child tasks and free
resources. Under `2026-07-28`, closing an HTTP SSE response stream signals
cancellation of that request; stdio uses `notifications/cancelled`. Older
revisions have different disconnect/resumption semantics: test the chosen SDK
and transport, not a universal disconnect rule.

Retry only bounded, classified transient failures and safe/idempotent work. Do
not retry mutations after ambiguous completion without an idempotency/recovery
contract. Cancellation does not undo committed effects: report their state via
the application's reconciliation/status path when necessary. Implement orderly
shutdown and verify no orphan processes, streams, or request-scoped tasks remain.
See [cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation).
