# Agent Instructions

Cross-project defaults for agents working on this machine.

## Public And Outbound Content

Treat anything written outside the local working context as potentially public and
long-lived. Before writing PR descriptions, commit messages, issue bodies, review
comments, docs, or content sent to an external service:

- Do not name ignored, redacted, local-only, or environment files, and do not
  describe what was excluded.
- Do not include home paths, private network addresses, unrelated projects,
  secrets, tokens, credentials, personal contact details, or account identifiers.
- Keep local-only details in chat with me, not in public artifacts.
- Do not put my personal email or contact details into commands, headers, code,
  config, logs, telemetry, User-Agent strings, or external requests. Use a neutral
  placeholder such as `noreply@example.com`, or omit the field.

## Git And GitHub

- Default branch is `main`. Use `develop` for integration when the project has
  that branch, and open PRs into `main` unless project instructions say otherwise.
- Use the `gh` CLI for GitHub operations.
- Commit or push only when I ask.
- Do not add agent attribution, session trailers, generated-by footers, internal
  model details, or tool runtime details to commits, PRs, issues, or review
  comments.

## Local Organization

- Reusable context lives in this file.
- Reusable skills, MCP definitions, workflows, subagents, and related agent
  documents live in sibling directories alongside this file.
- When editing or updating reusable agent materials, update the sibling
  directories alongside this file, such as `Skills/`, `MCP/`, `Workflows/`, and
  `Subagents/`.

## Working Style

- If something I ask for is technically wrong or impossible, say so and propose a
  workable approach.
- When giving me app or server URLs in chat, use this machine's LAN IP instead of
  `localhost`, because I often access local services from other devices.
- When giving me an app URL for a project with any kind of login, include working
  demo credentials when available: email, password, and role. Source them from
  the project's seed/demo data or fixtures. If they require a seed step that may
  not have run, say so and offer to run it.
