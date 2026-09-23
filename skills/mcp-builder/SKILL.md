---
name: mcp-builder
description: Design, implement, migrate, or review Model Context Protocol (MCP) servers and their client integrations. Use for tool/resource/prompt contracts, protocol and SDK compatibility, local stdio or remote HTTP deployments, authorization, and interoperability testing. Follow the repository's language and verified client capabilities rather than requiring a particular SDK, provider, or operating system.
license: Complete terms in LICENSE.txt
---

# MCP Builder

Build the smallest MCP surface that lets the intended clients perform authorized
work reliably. Preserve repository conventions; MCP is an interface boundary, not
a reason to replace the application's architecture or adopt a preferred language.

Maintenance notice: this file and the bundled reference guides have been
substantially rewritten for version-aware, portable development. The original
[license](LICENSE.txt) is retained.

## 1. Establish the compatibility contract

Inspect the repository, dependency locks, deployment configuration, existing
clients, and tests before choosing APIs. Record:

- intended workflows, consumers, data owners, and permitted side effects;
- exact SDK distribution/version, language/runtime, supported protocol revisions,
  client versions, and transport;
- available test tools, shell, process-launch mechanism, and network permissions;
- authentication source, per-operation authorization, tenant boundaries, and
  deployment trust boundary;
- required capabilities versus optional enhancements and unsupported fallbacks.

Read the official specification **for the selected revision** and release/tag
specific SDK documentation. A current specification, an SDK major version, and a
client's supported revisions are different facts. Do not infer interoperability
from one of them. If network access is unavailable, use installed documentation
and source; mark unresolved claims rather than inventing API signatures.

Read [protocol and security guidance](reference/mcp_best_practices.md) before
implementation. It distinguishes the `2026-07-28` per-request protocol from the
legacy initialization model. Recheck the official versioning page when updating:
this skill's examples are compatibility landmarks, not perpetual version pins.

Select an SDK already compatible with the project. Optional adapters:

- [TypeScript/JavaScript](reference/node_mcp_server.md)
- [Python and FastMCP distinctions](reference/python_mcp_server.md)

Other languages and runtimes are valid. Verify equivalent SDK operations instead
of translating imports or protocol internals by guesswork. No bundled script,
Python interpreter, Node runtime, browser, container, or paid model is required
merely to use this skill.

## 2. Design a bounded interface

Choose primitives by ownership and interaction, not by mapping every upstream
endpoint to a tool:

| Primitive | Use | Design checks |
| --- | --- | --- |
| Tool | Client/model-invoked action or query | Input/output schema, permissions, side effects, retries, size limits |
| Resource | Addressable context read by a client | Stable URI/template, MIME type, access checks, bounded content |
| Prompt | User-selected reusable interaction | Arguments, messages, embedded context, injection boundaries |

Start with one representative workflow. Add broad API coverage only when the
actual consumers need it. Give tools distinct, action-oriented names and concise
descriptions explaining selection, inputs, outputs, limits, and side effects.
Tool annotations are hints, not enforcement or proof of safety.

For each operation, specify:

1. Inputs: required fields, types, bounds, enums, defaults, unknown-field policy,
   identifiers, and path/URL validation.
2. Outputs: result shape, optional output schema, empty/not-found behavior,
   pagination, truncation indicators, and safe error messages.
3. Authority: authenticated principal, tenant/object access, allowed upstream
   credentials, and any approval required before mutation.
4. Execution: deadline, cancellation propagation, upstream concurrency/rate
   limits, retryable failures, and idempotency strategy.
5. Tests: valid request, invalid arguments, unauthorized access, upstream failure,
   and an observable success condition.

Keep MCP schemas separate from business rules and upstream wire formats. Reuse
existing domain services and map their results at the MCP boundary; do not embed
credentials or transport details in model-visible arguments.

## 3. Implement one vertical slice

1. Register a bounded read-only operation with the selected SDK.
2. Validate input and authorization before upstream access. A resource URI or
   opaque object handle does not replace an access check.
3. Call the existing service/client with a deadline and cancellation signal.
4. Convert the result into valid MCP content, preserving `isError` and structured
   data. Verify any advertised output schema against the actual wire result.
5. Connect a real protocol client over the intended transport and exercise both
   success and failure before adding more operations.

Then add resources, prompts, mutations, subscriptions, or user interactions only
when justified and supported. Gate optional features on the selected revision and
client capabilities. Unsupported elicitation must have a documented fallback or a
clear unavailable result; do not silently continue a sensitive action.

Use stderr for local stdio diagnostics; stdout is exclusively protocol traffic.
Use the project's server logging for HTTP, with redaction and correlation IDs.
Keep network authorization separate from local process configuration. Never
assume loopback, a session ID, a tool annotation, or model approval authenticates
a caller.

## 4. Verify behavior before optional model evaluation

Follow [testing and evaluation](reference/evaluation.md). Prefer the repository's
test runner and an installed compatible MCP client. An inspector is optional;
launching it may install packages or expose a listener, so check permissions and
configuration first.

Minimum verification covers schema enforcement, wire-level discovery/calls,
pagination, errors, authorization isolation, cancellation/timeouts, transport
cleanup, and the actual client compatibility matrix. If a runtime or client is
unavailable, perform static review and provide exact remaining checks; do not
claim protocol interoperability from a compile or syntax check.

Only then consider model-assisted usability tests with explicit outbound-data
approval, safe fixtures, enforced tool permissions, and time/cost/step limits.
No particular provider, XML format, fixed question count, or exact-string grading
is required.

## 5. Deliver operationally useful output

Report:

- implemented workflows and deliberately unsupported capabilities;
- SDK/runtime/protocol/client versions and transports actually verified;
- reproducible project-native build, run, and test instructions;
- configuration variable names and secret provisioning, never secret values;
- auth/authorization, limits, retry/cancellation behavior, and cleanup ownership;
- tests run, remaining compatibility gaps, and any required deployment approval.

For local launch instructions, use the host's command/argument configuration and
quote paths appropriately for its OS. For HTTP, document TLS, listener/proxy
settings, authorization metadata, Origin/Host checks, and health/readiness
behavior. Do not assume a particular shell, filesystem layout, package manager,
or process supervisor.
