---
name: gh
description: Use the GitHub CLI (`gh`) reliably for repositories, issues, pull requests, releases, search, and API access. Use whenever a task requires GitHub CLI commands, especially structured output, pagination, cross-repository targeting, capability checks, or `gh api` fallbacks. Verify installed-command support instead of assuming preview or future flags exist.
---

# GitHub CLI

Prefer stable `gh` commands and machine-readable output. The installed CLI,
authenticated host, repository permissions, and GitHub product (dotcom versus
GHES) determine what is available; never infer support from a remembered version.

This skill is host- and shell-neutral. Examples show argument structure, not a
promise that POSIX shell syntax works in PowerShell or `cmd.exe`. Adapt quoting,
line continuation, environment variables, redirection, paths, and executable
lookup to the active shell—or invoke `gh` directly through the harness/process
API. Replace placeholders such as `OWNER/REPO`, `HOST`, and `ISSUE_NUMBER` before
execution; never paste angle-bracket placeholders into a shell.

Follow the global privacy and Git authorization rules before any remote read or
write, including authentication checks. Reading remote data may disclose
repository names, search terms, headers, and client metadata. Obtain scoped
network authorization unless the current request already covers that destination
and purpose; use only the minimum necessary query.

## Establish context

Before a non-trivial operation, check only what is relevant. Confirm that `gh`
is installed and on `PATH`; if absent, report it rather than installing software
without approval. Do not initiate interactive authentication automatically.
`gh --version` and trusted built-in command help are local capability checks.
Only after remote-read authorization, verify the chosen repository as needed:

```text
gh repo view OWNER/REPO --json nameWithOwner,url
```

`gh auth status` tests remote authentication; it is not a local prerequisite for
writing or reviewing command examples. See the authentication section before
using it, and never capture its raw account diagnostics in the agent transcript.

A repository command run inside a checkout usually infers the repository from
Git remotes. Pass `--repo OWNER/REPO` (`-R`) when the target should be explicit,
when outside a checkout, or when multiple remotes make inference ambiguous.

For a flag, field, or subcommand that may be new, preview, extension-provided, or
GHES-dependent, inspect the installed CLI immediately before using it. Establish
alias/extension provenance and trust from local registration/configuration before
executing it, even with `--help`; help can run arbitrary extension code. Replace
`COMMAND` and `SUBCOMMAND` with trusted commands; cache invariant capability checks
within a session:

```text
gh COMMAND SUBCOMMAND --help
gh extension list
```

Do not document or execute an unavailable command and hope the server accepts it.
If the typed command lacks a feature, use `gh api` against a documented endpoint
or explain that the installed CLI/server does not support it.

## Structured output

Default tables are for people, not parsers.

- Use `--json field1,field2` when the command supports it.
- Use `--jq '<expression>'` for filtering or shaping JSON.
- Use `--template '<go-template>'` only when formatted text is the required
  output. Check help because `-T` means a body template on some create commands.
- When supported, invoking `--json` without fields prints the available fields;
  otherwise use the command's help.
- Do not parse colored tables, terminal spacing, or prose messages.

Example:

```text
gh pr list -R OWNER/REPO --state open --limit 100 --json number,title,author,url --jq QUERY
```

Supply `QUERY` as `.[] | {number, title, author: .author.login, url}` using the
active shell's quoting rules.

## Pagination and completeness

Many list and search commands default to a small limit. Set `--limit` explicitly
when completeness matters, but do not pretend an arbitrary large limit proves the
result is exhaustive.

For REST endpoints:

```text
gh api --paginate API_ROUTE --slurp
```

For example, `API_ROUTE` may represent the URL-encoded route for open issues with
a page size. The REST issues endpoint can also return pull requests; exclude
objects containing `pull_request` when an issue-only inventory is required.
Check `gh api --help` before relying on `--paginate` or `--slurp`.

`--paginate` follows pagination links. `--slurp` wraps page outputs in an outer
array; shape it deliberately rather than assuming one flat array.

For GraphQL, request `pageInfo { hasNextPage endCursor }` and iterate with an
`after` variable. Prefer a direct `totalCount` query when only a count is needed.
GitHub Search APIs have result caps and index behavior; report those limitations
instead of presenting capped search output as a full inventory.

## Search versus repository lists

- Use supported `gh search` subcommands such as `issues`, `prs`, `code`, `repos`,
  or `commits` for cross-repository or search-index queries.
- For user searches, use `gh api --method GET search/users -f q=SEARCH_QUERY`
  with the active shell's quoting rules; `users` is not a `gh search` subcommand.
- Use `gh issue list --search <query>` or `gh pr list --search <query>` for a
  single repository.
- Pass qualifiers to `gh search` as separate arguments unless quoting free text:

```text
gh search issues repo:OWNER/REPO is:open label:bug SEARCH_TEXT
```

Pass `SEARCH_TEXT` as `startup failure` using the active shell's quoting rules.

Check the relevant help for supported qualifier flags. App-authored activity may
need an app qualifier or the bot account's exact login; verify against returned
data rather than hard-coding one spelling.

## Safe writes

Before creating or changing a remote object:

1. Confirm the target host and `OWNER/REPO`.
2. Read the exact title/body/comment and scan it for private paths, credentials,
   unrelated project details, and agent/session metadata.
3. Obtain any authorization required by the global Git/privacy policy.
4. Prefer `--body-file` for multiline content so shell quoting cannot alter it.
5. Verify what GitHub stored when supported and authorized. For bulk workloads,
   use batched or sampled verification appropriate to the mutation and report the
   limitation rather than issuing an expensive read after every item.

Example argument patterns:

```text
gh issue create -R OWNER/REPO --title TITLE --body-file BODY_FILE
gh issue view -R OWNER/REPO ISSUE_NUMBER --json title,body,url
```

Resolve and verify `BODY_FILE` within the intended working directory, then pass
it using the active shell's path and quoting rules.

Do not assume flags for issue types, parent/sub-issue links, dependencies,
discussions, or repository-file reading exist. These features vary by CLI
version, extension, host, and rollout. Check `--help`; otherwise use `gh api` or
GraphQL after consulting the current endpoint/schema.

## `gh api` fallback

Use the API when a typed command cannot expose the required field or operation:

```text
gh api API_ROUTE --paginate
gh api graphql -f query=GRAPHQL_DOCUMENT -f owner=OWNER -f repo=REPO
```

For multiline GraphQL or JSON, prefer the installed command's documented input
file/stdin support or a direct process API instead of embedding it in shell
syntax. Verify endpoint and schema availability on the authenticated host,
especially for older GHES installations.

Use `-f` for strings, including GraphQL documents, owner names, repository names,
and opaque IDs/cursors. `-F` converts integer, boolean, and null literals and can
interpret file/placeholder syntax: a repository literally named `123`, `true`, or
`null` must remain a string. Reserve `-F` for intentionally typed values or
explicitly wanted expansion. Consult `gh api --help` for input-file, method,
preview-header, and pagination behavior in the installed version.

For repository contents without cloning, use the REST contents endpoint after
URL-encoding repository paths and refs. Prefer the endpoint's raw media type or
decode its base64 `content` field through a binary-safe runtime/library; do not
use a text pipeline such as `tr | base64`, which is not portable and can corrupt
binary data. For directory listings, request JSON and shape only needed fields.

Validate destination paths against collisions, path traversal, Windows-reserved
names, and filesystem-invalid characters. Never overwrite an existing file
without approval. For large files, LFS objects, submodules, symlinks, trees, or
history, choose an appropriate Git/API strategy and verify required tooling
rather than assuming a shallow clone or contents response is sufficient.

## Authentication and interactivity

Use `gh auth status` only when its remote checks are authorized and necessary.
Its normal diagnostics identify accounts; do not send raw stdout/stderr to chat,
logs, or a transcript-capturing tool result. Never use `--show-token` or print
authentication/configuration secrets.

Check local help for this version's output and exit-status contract. If its
selected-host/account exit status answers the question, use a process runner
that suppresses both output streams and exposes only that status. Otherwise use
a supported restricted/redacted result mechanism, or ask the user to check
authentication outside the captured transcript. Do not improvise prose scraping
or assume JSON mode and exit codes have the same semantics across versions.

Provide all required fields for non-interactive create/edit commands. Leave
`GH_FORCE_TTY` unset unless terminal-style behavior is explicitly needed. Do not
invent a universal `--no-pager` flag; check command help and use environment
controls only when output behavior actually requires them.

## Verification checklist

- Correct host and repository targeted.
- Installed command/flag/JSON field confirmed.
- Limit or pagination made explicit.
- Search/API caps disclosed.
- Exact outbound content reviewed and authorized.
- Mutated object read back after creation or edit.
- Errors handled from exit status and structured response, not prose scraping.
