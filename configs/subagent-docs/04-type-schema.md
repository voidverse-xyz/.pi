# Type Definition Schema — subagent type .md files

> **Historical — superseded.** This schema snapshot includes retired fields. Use the current parser in the Pi Subagents package and `03-tool-surface.md` for active behavior.

Decided 2026-07-09 (D6, D18, D19, D20). A type is a markdown file with YAML
frontmatter; the body is the agent's role prose (context layer 3, D18).

Discovery (D6): `~/.pi/agent/subagents/<type>.md` (global) and
`<project>/.pi/subagents/<type>.md` (project; wins on name conflict). Live-resolved
at wake; resolved-file hash recorded in instance state. A definition must be an
independent regular file: symbolic links and files with multiple hard links are
ignored so the same constitution cannot be mutated through an unprotected alias.

Doctrine (D19): every frontmatter field is type-fixed. `subagent_spawn` carries
only instance identity: id, team, lifetime, task. Need a variant → write another
type file.

## Example

```markdown
---
name: refactorer
description: Refactors code within a defined purview, incrementally and test-safe

model: anthropic/claude-opus-4-8
thinking: medium

projectContext: true

tools: [read, grep, find, ls, edit, write, bash]
readOnly: false
writePaths: ["src/auth/**", "tests/auth/**"]
denyPaths: ["migrations/**"]

maxTokensTotal: 500000
maxTurnMinutes: 15
maxContextCompactions: 3
---

You are a refactoring specialist. You own a specific purview of the codebase...
```

## Fields

| Field | Req | Default | Notes |
|---|---|---|---|
| name | ✓ | — | must equal filename stem; runtime errors on mismatch |
| description | ✓ | — | audience = the main agent's LLM choosing a type: what it's for, when to use it (may advise intended lifetime) |
| model | | inherit session | pin only when the type genuinely needs it |
| thinking | | inherit session | Pi thinking level |
| projectContext | | true | false = omit AGENTS.md layer (D18) — for non-coding purviews where project imperatives would interfere |
| tools | | all coding tools | allowlist of tool names — capability (what verbs exist) |
| readOnly | | false | shorthand hard override: no edit/write; bash restricted to non-mutating |
| writePaths | | cwd | glob scope for mutations — territory. Reads unrestricted (readPaths deferred until a real need) |
| denyPaths | | [] | globs where mutation is forbidden even inside writePaths |
| maxTokensTotal | | global setting | D27 whole-life warning threshold; execution continues |
| maxTurnMinutes | | global setting | running-time warning threshold; execution continues |
| maxContextCompactions | | global setting | chronic-saturation warning threshold; execution continues |

NOT in frontmatter (by design): lifetime (spawn-only, main-agent decision — D20),
team/comm config (membership is spawn-time; powers are matrix-fixed — 01), escalation
routing (always the human — D10), mailbox behavior (contract-fixed — 02), id.

## Sandbox semantics

- Precedence: readOnly > denyPaths > writePaths > default-cwd. Deny beats allow on
  overlap.
- Paths resolved to real paths before checking (symlink defense).
- Bash under a path-restricted type: mutation heuristics — commands that look
  mutating and aren't provably inside writePaths → escalation envelope. A
  path-qualified executable always escalates; only a bare command name can match
  the trusted read-only/mutator tables. Fails safe: false positives become human
  decisions, never silent writes.
- Implicit system denials, non-overridable, for every agent regardless of type:
  the subagents/ state tree (mailboxes, sessions, teams.json, registry) and the
  type-definition directories. Prevents self-modified type files (privilege
  escalation) and forged teammate mail.
- Anything attempted outside tools/paths → escalation to the HUMAN (D10). No
  per-type escalation config in v1 — the policy is the boundary.

## Lifetime rule (D20, tightens D13)

Lifetime is chosen at spawn, never in the type file. Oneshots never take an
explicit id — always auto `tmp-<short>`. **Named = persistent, anonymous =
disposable.** Get-or-create therefore only ever matches persistent agents, and
lifetime mismatch is impossible by construction.
