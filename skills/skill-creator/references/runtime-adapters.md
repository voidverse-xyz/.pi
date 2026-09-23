# Runtime adapters

The core skill-authoring workflow does not require any one agent runtime. Use an
adapter only after verifying current documentation and available capabilities.

## Adapter checklist

For any runtime, record:

- skill discovery paths and precedence,
- metadata schema and size limits,
- explicit and automatic invocation behavior,
- supported tools and permission/confirmation model,
- project versus user/global scope,
- reload or restart requirements,
- worker/subagent availability and isolation,
- file presentation and user-feedback options,
- packaging or distribution format,
- host OS and shell behavior.

Treat undocumented behavior as unstable. Keep runtime commands out of the core
skill unless every supported environment implements them.

## Pi

Read the installed Pi skills documentation and examples before editing runtime
resources. Pi installations may expose read/write tools, questions, file
presentation, subagents, teams, or deterministic procedures, but availability is
configuration-dependent. Use only tools visible in the current session.

Global and project skill locations, metadata extensions, and reload behavior can
change between Pi versions or local packages. Verify rather than copying paths
from another installation. Use Pi-native parallelism only when it improves the
evaluation; serial scenario checks remain valid.

## Claude-family runtimes

Claude Code, hosted Claude environments, and third-party harnesses do not share
one capability set. Check whether the environment supports filesystem access,
subagents, non-interactive CLI execution, browser opening, downloadable files,
and token/timing telemetry. Do not assume `claude -p`, `.claude/commands`, Cowork,
or a Unix temporary directory exists.

## Codex-family runtimes

Codex CLI, hosted tools, IDE integrations, and custom harnesses may expose
different skill discovery, sandbox, network, image, and worker capabilities.
Verify the installed product's documentation and active permissions. Do not reuse
Claude-specific invocation or metadata merely because both systems load Markdown
instructions.

## Other runtimes

When no skill mechanism exists, the artifact may need conversion into system
instructions, a command template, a tool description, documentation, or a
workflow definition. Preserve intent and safety boundaries while using the
runtime's native construct.

## Degraded/manual adapter

When automatic triggering or isolated execution cannot be tested:

1. Read the skill explicitly.
2. Apply it to representative tasks in separate contexts when possible.
3. Review outputs manually or with deterministic checks.
4. State that automatic discovery/triggering was not verified.

Lack of a provider-specific optimizer, viewer, or subagent is not a blocker to
creating a sound skill.
