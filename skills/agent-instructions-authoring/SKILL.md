---
name: agent-instructions-authoring
description: Create, reorganize, deduplicate, or migrate persistent instructions for coding agents—repository AGENTS.md-style guidance, directory-scoped rules, user-level defaults, and vendor-specific rule files. Use when the user asks to add agent rules, coding conventions, repository guidance, scoped instructions, or convert old prompts/commands/rules into skills or procedures. Chooses the correct artifact, verifies platform scope and precedence, keeps instructions concise and non-conflicting, preserves exact requested wording, protects private/local details, and migrates without deleting originals until validation and explicit confirmation.
---

# Agent instructions authoring

Persistent instructions shape every applicable agent turn. Put only durable, high-value guidance there; route optional expertise and procedures to more appropriate artifacts.

## 1. Choose the correct artifact

Before writing, classify the content:

| Need | Best home |
|---|---|
| Durable repository facts, constraints and conventions | Project instruction file (`AGENTS.md` or verified platform equivalent) |
| Guidance for one subtree/file family | Directory-scoped instruction/rule supported by the platform |
| Personal defaults across unrelated projects | User-level instructions/config, kept machine-local when appropriate |
| Optional reusable expertise that should trigger by task | Skill |
| Ordered multi-stage process or approval protocol | Procedure |
| Isolated specialist behavior and output contract | Subagent definition |
| Deterministic event enforcement | Hook |
| Typed action the model intentionally calls | Tool/extension |

Do not turn every command into an always-loaded rule. Do not create a skill for a convention that must apply to every edit. Avoid duplicating the same guidance across instruction, skill and procedure layers.

## 2. Verify scope and precedence

Instruction locations and precedence differ by platform. Read current installed documentation and repository conventions before choosing a file or frontmatter field.

Determine:

- User-wide, repository-wide or directory-local scope.
- Whether child instruction files extend or override parents.
- Whether file globs are supported and how they are matched.
- Whether instructions load automatically, by description, or only when named.
- Which file is source of truth when several formats coexist.

Never invent vendor-specific fields such as `globs`, `alwaysApply`, priority or invocation flags. Use them only after verifying the target runtime's schema.

## 3. Gather intent without repeating known context

Extract from the conversation first:

- The behavior or fact to preserve.
- Where it applies and where it must not apply.
- Whether it is mandatory or a default that may be overridden.
- The reason it matters.
- Concrete good/bad examples, if useful.
- Conflicts with existing instructions.

If the user supplies exact wording, preserve it verbatim unless they ask for editing. Put it in the correct structural location without silently softening, expanding or reinterpreting it.

## 4. Write instructions that stay useful

Good persistent instructions are:

- **Scoped:** one concern and a clear applicability boundary.
- **Actionable:** say what to do, not merely what quality to value.
- **Grounded:** name stable repository concepts, not transient implementation details.
- **Reasoned:** explain why when the tradeoff is not obvious.
- **Non-redundant:** link to one source of truth rather than copying long blocks.
- **Testable:** a reviewer can tell whether the instruction was followed.
- **Maintainable:** concise enough to read whenever it applies.

Use priority words sparingly. Resolve contradictions instead of stacking more “always” and “never” statements on top.

Prefer neutral placeholders in reusable examples. Keep personal paths, private hosts, credentials, account identifiers and unrelated project details out of committed instructions.

## 5. Organize by scope

Use the broadest level that is still correct:

- Repository root: project-wide build/test rules, architecture map, public/outbound policy, source-of-truth locations.
- Subdirectory: language/framework/domain conventions that only apply there.
- Skill/procedure reference: detailed procedures too large or optional for persistent context.
- User-level: stable personal preferences that do not belong in a shared repository.

Do not put project-specific memory into a global reusable instruction file. Do not put host-specific config into a repository just because the agent needs it locally.

When file-pattern scoping is supported, test positive and negative examples. Globs and regular expressions vary across platforms; verify the actual matcher semantics.

## 6. Manage size and references

Keep the root instruction file as an index plus critical rules. Move detailed reusable material to the designated Skills, Procedures, Plans, Subagents or project documentation directories.

- Link directly to the relevant file rather than through a chain of indexes.
- Keep referenced material one level deep where practical so agents reliably discover it.
- Avoid duplicating a whole policy merely to make it visible in two locations.
- State which location is authoritative when compatibility copies are unavoidable.
- Remove stale references when moving material.

## 7. Migrate old rules, commands and prompts safely

Migration is classification, not blind file conversion.

### Inventory

Find all candidate instructions, rules, slash commands, prompt templates and skills. Record:

- Path and scope.
- Current trigger/application behavior.
- Body hash or exact baseline.
- References and dependencies.
- Whether it contains private or machine-specific data.

Ignore vendor-managed/built-in directories unless the task is explicitly to archive them.

### Classify each source

- Always-on convention → persistent instruction.
- File-scoped convention → scoped rule/instruction if the target supports it.
- User-invoked procedure → procedure or explicit-invocation skill.
- Automatically useful domain expertise → skill with a precise description.
- Specialist prompt → subagent definition.
- Event automation → hook.
- Obsolete/duplicated content → archive candidate, not an automatic deletion.

### Preserve before transforming

Create the new artifact while leaving the original intact. Preserve the original body byte-for-byte in a baseline or source archive when fidelity matters. Add new metadata around it; do not claim a verbatim migration if the body was rewritten.

Validate the new artifact's name, metadata, links and trigger behavior. Test representative should-apply and should-not-apply cases.

### Cut over deliberately

1. Show the old-to-new mapping.
2. Verify every new artifact loads and behaves correctly.
3. Update authoritative references/configuration.
4. Disable the old source reversibly when possible.
5. Delete originals only after explicit user confirmation.
6. Keep rollback instructions until the migration is accepted.

Never make deletion a hidden default step. Never delegate destructive migration to children without a parent-controlled confirmation and complete result collection.

## 8. Review existing instructions

Check for:

- Contradictions between parent and child scopes.
- Duplicate rules with slightly different wording.
- Stale file paths, commands, branches or package names.
- Rules that describe a one-time migration rather than durable behavior.
- Tool-specific fields copied into another platform.
- Excessive context cost compared with the frequency/value of the rule.
- Public files that expose private/local filenames or environment details.
- Instructions that authorize commits, pushes, network access or destructive actions too broadly.

Prefer consolidation and clear ownership over adding another compatibility layer.

## Verification checklist

- [ ] Target platform and instruction schema verified from current local docs/source.
- [ ] Artifact type matches the content's real lifecycle.
- [ ] Scope and precedence are explicit.
- [ ] Exact user wording preserved where requested.
- [ ] Existing related instructions were read and deduplicated.
- [ ] Reusable content is project/host agnostic.
- [ ] Project-specific content is stored project-locally.
- [ ] No private/local details leaked into committed guidance.
- [ ] Positive and negative applicability cases tested.
- [ ] Links and source-of-truth statements resolve.
- [ ] Migration kept originals until verification and explicit deletion approval.
- [ ] Rollback path is documented.
