# MCP Testing and Evaluation

Summary: deterministic contract and security tests come first. Model-assisted
usability evaluation is optional and cannot replace protocol interoperability.

Maintenance notice: substantially rewritten; see `../LICENSE.txt`. The previous
provider-specific scripts and XML fixtures are no longer part of this package.
Use the project's test tooling or an explicitly approved evaluation adapter.

## 1. Define the tested configuration

Record SDK/runtime versions, protocol revisions, transport, client/version,
optional capabilities, fixture revision, and configuration excluding secrets.
Test the actual combinations promised to consumers; unsupported combinations
should fail explicitly rather than be counted as successful coverage.

Prefer deterministic local fixtures or a controlled sandbox. Separate pure
handler tests from wire-level tests and authorized live-service checks. Even
read-only live access may expose private data or incur cost.

## 2. Minimum contract suite

| Scenario | Required observation |
| --- | --- |
| Discovery | Legacy initialization or modern `server/discover`/per-request metadata works for the selected revision; unsupported versions fail correctly |
| Direct modern request | Works without an earlier discovery call when modern support is claimed |
| Capability gate | An absent optional capability does not trigger unsupported interaction; documented fallback is exercised |
| Lists | All MCP list pages are traversed; empty and repeated/expired cursor cases are bounded |
| Valid operation | Inputs validated, intended service invoked, schema-conforming wire result returned |
| Invalid arguments | Correct SDK/protocol error layer; no unintended upstream request or mutation |
| Output schema | Actual serialized structured data conforms, including empty/nullable cases and applicable error rules |
| Execution failure | Domain/upstream failure is recognizable, with `isError` preserved and safe actionable text |
| Protocol failure | Unknown method/tool or malformed envelope is not reported as a successful tool result |
| Resource/prompt | URI/arguments, MIME/content, missing object, and access checks work without leaking context |
| Large result | Limits/truncation are explicit; continuation works; JSON/media remains valid |
| Timeout/cancellation | Deadline bounds work, propagates upstream, and releases resources under the selected transport semantics |
| Mutation retry | Duplicate or ambiguous completion does not duplicate effects; idempotency/reconciliation is verified |
| Parallel requests | IDs/results correspond; user/tenant context does not cross requests |
| Cleanup | Startup failure, disconnect, and shutdown leave no owned child processes/streams/tasks |

Test modern multi round-trip interactions when used: accept, decline, cancel,
unsupported mode, invalid responses, tampered/expired/replayed `requestState`,
abandonment, and round limits. Check that retries do not repeat committed effects.
For legacy sessions or modern subscriptions, test their actual lifecycle and
cleanup rather than assuming the same behavior across protocol revisions.

## 3. Security and transport suite

For stdio, launch through the same command/argument interface as the consumer.
Test paths with spaces, controlled environment inheritance, stderr diagnostics,
stdout purity, EOF handling, and nonzero startup exit. A direct function call or
an in-memory transport cannot establish process-launch portability.

For HTTP, test the mounted route, configured proxy, and listener security:

- missing/expired/invalid/wrong-audience token and insufficient scope;
- valid user denied access to another user's object, cursor, handle, or cache;
- invalid Origin and Host/DNS-rebinding defenses;
- method, content-type, version-header, body-size, and malformed-body handling;
- streaming, disconnect, timeout, and any claimed reconnect/resumption behavior;
- metadata/discovery and auth challenge behavior for the chosen authorization flow.

For every externally influenced input, test the relevant boundary: traversal,
SSRF and redirects, subprocess argument injection, untrusted schema references,
and prompt-injection content returned by upstream systems. Verify that no secret
appears in errors, results, logs, snapshots, or model-visible transcripts.

Do not expose a listener, download an inspector, install dependencies, or contact
external services without the applicable permissions. An installed inspector can
help inspect schemas/calls, but passing its happy path is not a security audit.

## 4. Optional usability evaluation

Use this only when model behavior matters to acceptance and the necessary model
and data transfer are authorized. Otherwise, have a human manually exercise the
same scenarios through a compatible client; report that this is manual review,
not an automated model evaluation.

Choose a small representative set, not an arbitrary fixed count:

- one straightforward query with an exact fixture-backed result;
- a multi-step workflow requiring pagination or a resource read;
- ambiguous tool selection with a clear expected choice;
- invalid input or upstream failure with an actionable recovery path;
- a denied or approval-dependent action;
- a mutation only in an explicitly authorized, resettable sandbox.

Define observable expectations before the run: selected operation, permitted
arguments, required output fields, correct refusal/approval behavior, and side
effects. Use semantic/structured assertions where appropriate; exact string
comparison fits only intentionally exact identifiers or values. For changing
upstream data, freeze fixtures or document the snapshot/time window.

An adapter must:

1. Obtain explicit approval for the provider/destination, submitted fixture/data
   categories, and any cost. Minimize/redact data; do not forward credentials.
2. Enforce a tool allowlist and authorization outside the model. Tool annotations
   and instructions saying "read-only" do not prevent writes or disclosure.
3. Discover complete paginated tool lists and preserve descriptions and schemas
   supported by that provider. Declare lossy conversions or unsupported schemas.
4. Handle every tool call in an assistant turn, matching exactly one result to
   each tool-call ID, including denials and errors. Do not execute only the first
   call while forwarding the whole turn. Preserve ordering/dependencies where
   required; parallelize only independent, authorized operations.
5. Serialize SDK content correctly, preserve `isError` and structured data, and
   account for non-text content. Never claim a failed or omitted call succeeded.
6. Set per-call and total deadlines, maximum model turns/tool calls, output sizes,
   and provider token/cost budgets when supported. If spend cannot be bounded by
   the adapter, use provider-side limits or do not run a paid evaluation.
7. Stop safely on cancellation, denied permissions, repeated errors, or budget
   exhaustion. Close clients/processes and retain only approved, redacted evidence.

For before/after comparisons, use equivalent fixtures, model settings, budgets,
and acceptance criteria. Include failed attempts and infrastructure errors;
do not cherry-pick successful runs. A model grade is supporting evidence, not
proof of correctness or secure authorization.

## 5. Report evidence and limits

Keep results in the repository's existing test/report format. If none exists,
a concise table is sufficient:

| Scenario | Expected | Observed | Result | Evidence/limit |
| --- | --- | --- | --- | --- |
| Unauthorized resource read | Denied before upstream access | Recorded test result | Pass / fail / not run | Test name or redacted trace |

Distinguish static review, compilation, deterministic unit tests, real protocol
client tests, manual usability review, and live/model evaluation. List untested
platform/client combinations and exact follow-up commands or procedures. Never
claim runtime interoperability or improved task quality solely from static checks.
