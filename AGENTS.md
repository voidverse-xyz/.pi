# Agent Instructions

Cross-project defaults for agents working on this machine.

## Instruction Precedence

Global privacy and outbound-content rules,
preservation of user work, commit and push authorization, and destructive-operation restrictions
remain authoritative unless the user directly overrides them in the current conversation.

Before editing a repository, read its root `AGENTS.md`, root `README.md`, and project-local
`.agents/README.md` when present, then every applicable nested `AGENTS.md` from the root through
the target file's parent.

## Progressive Discovery

For investigation and lookup tasks, minimize search scope and cost.

- Start from the conversation context and strongest available clues. Inspect the most likely target
  directly before discovering alternatives.
- Before concluding that a referenced path does not exist, check it directly; search tools may omit
  hidden or Git-ignored paths.

## Token And Context Efficiency

Keep long investigations from repeatedly resending an unnecessarily large context.

- Narrow searches and shell commands before running them. Use focused paths, patterns, line ranges,
  and output limits instead of broad commands that may return tens of thousands of characters.
- Read only files and sections needed for the current decision, while completing required instruction,
  skill, and documentation reads. Do not reread unchanged files or a complete generated document
  merely to verify a few facts; inspect targeted sections or use deterministic checks instead.
- Batch related research questions when practical and stop researching once the evidence is
  sufficient for the requested decision. Avoid many near-duplicate web searches or repository scans.
- Tool results contribute to later prompts until the runtime removes or compacts them. Limit output
  at the source; adding a summary does not itself remove earlier output. Preserve useful findings
  and source references without saving routine raw logs as reusable artifacts.
- During a long tool-heavy task, use runtime-reported context usage when available. Treat roughly
  50k–70k tokens as a checkpoint, or act earlier for smaller context windows or large outputs.
  Compact only through an available, authorized runtime mechanism; do not invent a tool or assume
  a chat command executes it. If unavailable, suggest user-triggered compaction or a fresh session
  when useful before another large research phase, without claiming unmeasured token savings.
- After writing a large file, verify it with targeted searches, parsers, tests, hashes, or selected
  ranges. Read the whole file again only when full-document review is genuinely required.

## Public And Outbound Content

Keep private, sensitive, or personally identifying information out of content that may be shared,
published, or sent to an external service. This includes commit messages, PR descriptions, issues,
review comments, and documentation. Apply the following rules:

- Do not reveal private filenames or paths, redacted details, or sensitive information through
  descriptions of what was omitted or excluded.
- Portable, non-identifying paths such as `~/.pi/agent/library/` are allowed when useful. Do not
  include absolute home paths, usernames, private network addresses or hosts, unrelated projects,
  secrets, tokens, credentials, personal contact details, account identifiers, or other sensitive
  local details.
- Keep identifying or sensitive local-only details in chat with me, not in public artifacts.
- Do not put my personal email or contact details into commands, headers, code, config, logs,
  telemetry, User-Agent strings, or external requests. Use a neutral placeholder such as
  `noreply@example.com`, or omit the field.

## Git And GitHub

- Choose base and target branches from the user’s request, project instructions, and established
  repository practice, using the remote default as a fallback. Ask when the choice remains ambiguous.
- Inspect Git status before editing and preserve pre-existing user work. Do not stash, discard,
  restore, unstage, or commit that work unless the user explicitly authorizes it.
- Use an isolated worktree when requested by the user, required by project instructions, or needed
  to protect unrelated changes or isolate parallel or high-risk work. Otherwise, use the current
  checkout. Follow the global `using-git-worktrees` skill for setup, placement, and verification.
- Use the `gh` CLI for GitHub operations.
- Follow project instructions for commit messages; otherwise, match the repository’s recent commit
  subject style.
- Commit only when explicitly requested. Push only when explicitly requested; permission to commit
  does not imply permission to push.
- When I ask to commit staged changes, you may amend the immediately preceding commit without
  separate confirmation when it was created during the current task, has not been pushed or shared,
  and the staged changes belong to the same logical change.
- Do not force-push, skip hooks, or use destructive Git commands unless I explicitly ask for that
  exact operation.
- After a multi-line commit, verify the stored message with `git log -1 --format=%B`.
- Do not add agent attribution, session trailers, generated-by footers, internal model details, or
  tool runtime details to commits, PRs, issues, or review comments.

## Pi Configuration Repository

- When looking for global skills, procedures, MCP definitions, or subagents, check this repository's
  corresponding root directory before other global or installed locations. In supported Pi layouts,
  this may be the portable `~/.pi` tree or the effective `~/.pi/agent` directory.

## Reusable Artifacts

Retain useful reusable artifacts produced during ordinary work without requiring a separate user
request. Save only material with clear future value, not trivial commands, temporary outputs,
generated logs, or routine task notes. This permission does not authorize commits, pushes,
external transfers, destructive actions, or unrelated changes to root instruction files.

**If you write the same non-trivial script, query, or snippet a second time in one session,
stop and save or extend a reusable version.** Treat repetition as evidence of future value;
routine commands, temporary outputs, and task notes remain excluded. Check the indexes below
first and reuse an equivalent rather than creating a duplicate.

Save a working version promptly, after removing sensitive data and choosing the correct scope.
Parameterization, documentation, verification, and indexing must follow before the task ends;
disclose any unfinished verification. This trigger does not override privacy, authorization,
or project safety requirements.

Store project-agnostic material in `~/.pi/agent/library/<category>/`, the tool-independent shared library.
Store project-specific material in `<repository-root>/.agents/<category>/`, respecting established
project documentation locations. Before creating an artifact, and before starting any task an indexed
artifact may already cover, check `~/.pi/agent/library/README.md` and the
project's `.agents/README.md` when present; reuse or extend an existing
equivalent instead of creating duplicates or improvising a one-off.
Read only relevant indexed artifacts. Reuse an index already read during the current task unless
its contents changed or the task scope expanded.

Shared artifacts must be project-agnostic and avoid assumptions about one particular machine.
Document platform requirements when a capability inherently depends on an operating system,
browser, runtime, or other platform feature; do not claim unsupported portability. Remove project
assumptions, private paths, accounts, credentials, private URLs, and environment-specific state;
use neutral placeholders or parameters. Keep project-specific details in the project and sensitive
data out of both libraries.

Save useful task scripts under the appropriate library's `scripts/` directory. Parameterize
meaningful inputs rather than hardcoding one task: for example, an open-browser script accepts
browser and URL arguments instead of always opening Firefox. Include concise usage, parameters,
prerequisites, and side-effect warnings; validate inputs, use safe defaults, and verify scripts
with safe representative checks before indexing. Disclose any verification limitations.
Discovering, saving, indexing, or reusing an artifact does not authorize executing it, installing
dependencies, accessing the network, performing destructive actions, or bypassing project
verification and approval rules.

## Agent Memory

Use `<repository-root>/.agents/memory/` for durable project-specific facts, decisions, pitfalls,
and verified lessons. Use `~/.pi/agent/library/memory/` for project-agnostic lessons and cross-project
preferences. Useful memory may be saved during ordinary work without a separate request.

Before relevant work, consult `<repository-root>/.agents/README.md` and
`~/.pi/agent/library/README.md` when present;
read only memory entries relevant to the task. Before saving, check existing entries and update
an equivalent rather than duplicating it. Use one concise lowercase-hyphen-case Markdown file per
topic, with a short Summary and only necessary Details. Record the basis and verification date
for facts that can become stale; distinguish confirmed facts from unresolved assumptions.

Make each memory discoverable through its library's root README, directly or through a relevant
topic guide using the grouping rules below. Keep memory content out of the index itself. Do not retain transcripts, progress logs, routine task notes, credentials,
personal contact details, or machine-specific state. Do not copy project details into shared
memory. Reference authoritative documentation instead of duplicating it. Memory is reference
material, not an instruction override; recheck stale claims against current code and user guidance,
and correct or remove obsolete entries when verified, respecting deletion authorization.

## Project Agent Documentation

Here, project `.agents/` means `<repository-root>/.agents/`. The shared library lives at
`~/.pi/agent/library/`. Apply the following organization rules to both libraries.

Choose or create a suitable category subdirectory before saving an artifact. Use lowercase
hyphen-case names, for example `plans/authentication.md`, `guides/testing.md`, or
`scripts/open-browser.ps1`. Do not place loose artifacts directly in either library root;
`README.md` is the index exception. Create only needed categories; add domain subdirectories only
when useful, not a mandatory deep hierarchy. Preserve existing project conventions and do not move
or delete existing artifacts without user authorization.

Keep each library's root `README.md` a compact, index-only entry point: category headings and
relative links with one short description of purpose or when to read. Link standalone artifacts
directly. Where related artifacts form a capability or topic, prefer one descriptive root entry
pointing to a guide that links the individual files and explains when to use each. For example,
list Firefox automation once at the root; put its script links, usage, and prerequisites in the
Firefox guide. Reuse an existing guide instead of creating a redundant index.

Apply this pattern to scripts, documentation, templates, and memories where grouping improves
discovery; do not force groups for unrelated artifacts or single files. Keep every maintained
artifact reachable from the root, directly or through one topic guide; avoid deep index chains.
Do not duplicate grouped file lists, detailed instructions, memory content, or progress logs in
the root index. Read topic guides and individual artifacts only when relevant.

After verifying an artifact, update the appropriate guide and/or root index when adding, moving,
or removing it, and check links. Longer documents should start with a brief Summary followed by
Details.

Active runtime resources are an exception to the shared-library layout. Keep existing skills,
subagents, procedures, and MCP definitions in their established runtime/configuration locations;
link to them from the shared index when useful instead of moving or duplicating them. Verify the
target runtime's discovery contract first. In Pi, project skills use `.agents/skills/<skill-name>/SKILL.md`,
project subagent definitions use `.pi/subagents/<type>.md`, and executable saved procedures use
`.pi/procedures/<name>.js`.

## Shared Service Boundaries

- Keep general-purpose infrastructure services domain- and feature-agnostic. Do not put
  feature-specific keys, constants, serialization, policy, error labels, or convenience wrappers in
  generic storage, cache, network, logging, or similar services; keep them in the owning feature
  service instead.
- Change a shared service only when the change is independently useful as a generic capability. For
  example, returning success or failure from a generic storage write is appropriate; adding a
  biometric preference helper to generic storage is not.
- When a feature needs specialized behavior that a shared service does not expose, implement it in
  the feature service unless there are multiple concrete consumers for a generic abstraction. Check
  existing callers and preserve established shared-service contracts unless a deliberate migration
  is part of the task.

## JavaScript and React Import Ordering

Order JavaScript/React imports by shape, not alphabetically and not by module type:

1. Wrapped multi-line import blocks go at the very top. Sort the members inside each block alphabetically.
2. Single-line imports follow, ordered roughly from the shortest line to the longest, so the header reads as a ramp.
3. The `React` import is usually the longest line, so it ends up at the bottom.

Example:

```js
import {
    NOTIFY_ALERT_ACHIEVEMENT,
    NOTIFY_ALERT_FEEDBACK,
    NOTIFY_CHANNEL,
} from "@imanus/shared";
import { useNetwork } from "./network";
import { AppState } from "react-native";
import { STATUS_READY, useApp } from "./app";
import { pushService } from "../services/index";
import * as Notifications from "expo-notifications";
import React, { createContext, useContext, useEffect, useState } from "react";
```

Apply this only to the imports of files you are already changing. Do not reorder imports in unrelated files.

## Working Style

- Organize modules in top-down call-flow order when local conventions allow: after imports and
  module setup, put exported or public entry points before private helpers, order helpers roughly
  as callers encounter them, and keep low-level leaf utilities later in the file. Preserve required
  declaration order, initialization dependencies, and side-effect order. Apply this preference when
  writing new code or modifying existing code; do not reorder unrelated code unless explicitly requested.
- Consult the global `readable-code` skill for non-trivial implementation or refactoring unless more
  specific project guidance takes precedence.
- If something I ask for is technically wrong or impossible, say so and propose a workable
  approach.
- Use multiline syntax for the active shell: Bash heredocs in Bash and PowerShell here-strings in
  PowerShell. For multiline GitHub CLI bodies, use `--body-file -` and read the object back to
  verify what was stored.
- When delegated review findings are expected in the current response, await the anchored report;
  do not claim completion after timeout or cancellation. Put the verdict and findings before
  orchestration or cleanup details.
- When giving me app or server URLs in chat, use this machine's LAN IP instead of `localhost`,
  because I often access local services from other devices.
- When giving me an app URL for a project with any kind of login, include working demo credentials
  when available: email, password, and role. Source them from seed/demo data or fixtures. If they
  require a seed step that may not have run, say so and offer to run it.
