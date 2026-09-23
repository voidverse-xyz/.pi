---
name: privacy
description: Prevent sensitive or private information from leaking through remote requests, commits, pull requests, issues, reviews, documentation, generated files, logs, or agent handoffs. Use before any outbound or public-facing action and whenever handling secrets, personal data, private repositories, local paths, internal hosts, or redacted material. Require clear, scoped user authorization before sending data to a remote service unless the current request already authorizes that exact destination and purpose.
---

# Privacy

Minimize what crosses the established trust boundary. “Local” does not
necessarily mean safe: containers, CI runners, remote workspaces, hosted IDEs,
WSL, plugins, mounted directories, subprocesses, and telemetry may process data
outside the user's machine or control. Determine the actual boundary for the
current workload. Outbound data can be retained in service logs, request
metadata, caches, indexes, forks, telemetry, or backups even when the visible
artifact is later edited or deleted.

Do not describe chat as inherently private: the agent provider, harness, plugins,
or logging configuration may process or retain it. Keep sensitive detail out of
chat too unless it is necessary to complete the user's task.

## Classify the data and destination

Before an outbound action, identify:

1. **Payload:** body, file contents, diff, prompts, query strings, URL paths,
   headers, filenames, branch/repository names, and generated metadata.
2. **Sensitivity:** secrets; credentials; personal, customer, health, financial,
   or proprietary data; private source; local paths; internal hosts/IPs; session
   IDs; unpublished vulnerabilities; and facts inferred from redactions.
3. **Destination:** service and account/organization, public or private scope,
   subprocess/plugin/MCP boundaries, redirects, proxies, and whether the user
   controls the receiver.
4. **Purpose and minimum:** why transmission is needed and whether a smaller,
   redacted, aggregated, or local-only input is sufficient.

A private IP range, VPN address, `.local` name, or loopback proxy does not by
itself prove that a destination is trusted. A public address does not prove it is
untrusted. Use the actual service and data-flow boundary when known; if it is
unclear, treat it as external and ask.

Outbound disclosure includes GET requests: URLs, query parameters, DNS lookups,
repository coordinates, search terms, headers, and client IP metadata can all be
logged. It is not limited to uploads or POST bodies.

## Authorization rule

Obtain explicit user authorization immediately before sending data to an
external service unless the current conversation already requests that exact
action with a sufficiently clear destination and purpose.

Authorization may cover a well-defined batch, for example: "create these three
issues in OWNER/REPO using the reviewed drafts." It does not silently extend to a
new service, repository, account, payload category, or purpose. A request to
commit locally does not authorize pushing; a request to push to GitHub does not
authorize uploading screenshots elsewhere.

For confirmation, state concisely:

- what will be sent,
- where and under which visible scope when relevant,
- why it is needed,
- any important retention/publication consequence.

Example:

> This will send the reviewed patch and description to the private repository
> `OWNER/REPO` on GitHub to open the requested PR. GitHub may retain request and
> repository data. Proceed?

Do not repeat sensitive values in the confirmation. Refer to them by category.
Avoid confirmation fatigue: one scoped approval can cover a coherent batch, but
ask again when its boundary changes.

## Minimize before sending

- Send only the fields and files required for the task.
- Prefer local processing, summaries, hashes, or small excerpts over entire
  repositories, logs, screenshots, or conversations.
- Remove secrets rather than masking only their display; inspect generated
  metadata, archives, image EXIF, notebook output, and source maps when relevant.
- Use neutral portable placeholders such as `<user-config-directory>/...`,
  `<home-directory>/...`, or `<repository-root>/...` in outward-facing text. Do
  not publish usernames or absolute home paths.
- Keep unrelated projects, accounts, internal hostnames, private IPs, and local
  tooling details out of external artifacts.
- Do not name redacted or deliberately excluded private files merely to explain
  that they were excluded. The existence and names can themselves be sensitive.
- Never send credentials through URLs, issue bodies, commits, or prompts. Do not
  assume command arguments, environment variables, response files, temporary
  files, process listings, shell history, CI logs, crash reports, or OS credential
  stores are safe without understanding the host and tool behavior. Use the
  documented approved secret channel; if none exists, do not transmit the
  credential and ask the user for an approved method.

## Public and durable artifacts

Treat commits, pushed files, PR/issue text, review comments, package metadata,
release notes, and published documentation as durable disclosures even when the
repository or channel is currently private. Access settings can change and copies
can persist.

Before publishing, review the exact final content when feasible. For large,
binary, encrypted, generated, or streamed artifacts, perform the strongest
practical review—such as manifests, file lists, provenance, metadata, decoded or
sampled content—and disclose limitations. Block transmission when sensitivity
cannot be bounded.

Review applicable content, including:

- commit subject, body, trailers, and signatures,
- staged file contents and generated files,
- PR/issue/review title and body,
- attachment names and metadata,
- URLs and query strings,
- tool-added attribution or session fields.

Do not add agent session URLs/IDs, internal model/build names, sandbox details,
absolute paths, or generated-by footers. Follow repository instructions for
attribution; otherwise omit agent attribution rather than inventing it.

Use targeted scans as a supplement, not proof. Review accessible outbound
material for likely secret formats, home paths, private hosts, emails, tokens,
session IDs, and names of intentionally withheld items. Use available native or
harness tools; do not install software, invoke a remote scanner, or upload files
merely to perform the review without authorization. When tooling is unavailable,
manually review the exact accessible payload and disclose limitations. A clean
pattern scan cannot establish that content is safe.

## Generic outbound actions

Apply the same review to package publication, container images and provenance,
cloud/object storage, email and chat attachments, database exports, deployment
systems, support portals, observability/telemetry, model providers, CI artifacts,
and generated binaries. GitHub is one example, not the default workload.

## Git and remote-service operations

This section applies when the workload uses Git or repository hosting.

- A local commit still creates durable content that may later be pushed, so run
  the disclosure review before committing.
- Verify the remote, repository, branch, and account before pushing or using a
  service CLI.
- Prefer structured API fields or the tool's documented file/stdin input for
  multiline content. Follow the active shell's quoting rules and avoid placing
  sensitive multiline content directly in command arguments.
- Read remote objects back after creation/edit when supported and authorized,
  preferably using narrowly scoped metadata or fields rather than retrieving or
  printing the entire sensitive object.
- Never reveal tokens with diagnostic flags or paste authentication output into
  chat or logs.
- Agent handoffs, web search, hosted model calls, remote MCP tools, and image
  generation are outbound services too; pass only the minimum necessary context.

## If disclosure occurs

1. Stop further transmission and tell the user what category of data, destination,
   and artifact were involved without unnecessarily repeating the sensitive value.
2. Remove or edit the visible artifact when possible.
3. Treat secrets and session credentials as compromised and rotate/revoke them.
4. Preserve evidence needed for remediation without spreading it to more systems.
5. Explain residual risk: caches, copies, logs, backups, and version-control
   history (for example, Git clones, forks, or reflogs) may retain prior content.
6. Ask before destructive history rewriting or force-pushing; deletion alone is
   not reliable remediation.

Privacy review is a decision process, not a promise that an artifact is safe.
When sensitivity or authorization is ambiguous, pause and ask rather than making
an irreversible disclosure.
