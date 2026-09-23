---
name: skill-creator
description: Create, revise, audit, or evaluate reusable agent skills across coding-agent runtimes. Use when designing a SKILL.md-style capability, improving triggering or instructions, migrating a provider-specific skill, organizing bundled scripts/references/assets, or testing whether a skill improves task outcomes. Verify the target runtime's discovery and metadata contract instead of assuming one vendor, operating system, shell, browser, or subagent API.
license: Complete terms in LICENSE.txt
---

# Skill Creator

Maintenance notice: substantially rewritten for portable, provider-neutral skill
authoring. The original [license and attribution](LICENSE.txt) are retained.

Create skills that are focused, discoverable, portable where intended, and
measurably useful. Treat a skill as a runtime-loaded instruction package—not as a
universal standard whose paths, metadata, tools, or invocation behavior are the
same everywhere.

## Start with capability discovery

Before editing or creating a skill, establish the target environment from current
documentation, repository instructions, and available tools:

- skill discovery locations and precedence,
- required filename and directory structure,
- supported frontmatter fields and limits,
- how explicit and automatic invocation work,
- available tools and permission model,
- whether bundled scripts, references, and assets are supported,
- host OS, active shell, runtime dependencies, and network policy,
- whether subagents, parallel execution, telemetry, browser UI, and packaging
  exist in this environment.

Do not infer these capabilities from another agent platform. When the target is
unknown, write a conservative core skill and document optional adapters rather
than embedding unsupported commands.

For Pi-specific skill work, read Pi's current skills documentation and relevant
examples before relying on metadata or discovery behavior. For another runtime,
use that runtime's authoritative documentation.

## Define the contract

Extract what is already known from the conversation and existing skill. Ask only
for consequential missing choices:

1. What user outcome should the skill improve?
2. Which requests should and should not trigger it?
3. What inputs, outputs, and side effects are expected?
4. Which environments must it support?
5. Which safety, privacy, or authorization boundaries apply?
6. How can success be observed or tested?

Preserve exact user-supplied policy or template wording unless the user asks for
editorial changes. Separate universal behavior from project-, platform-, or
provider-specific behavior.

## Decide whether a skill is the right artifact

Use a skill when reusable model judgment or a repeatable workflow is needed.
Choose another artifact when it fits better:

- deterministic repeated operation → script or tool,
- repository rules that should always apply → scoped agent instructions,
- reusable delegated role → subagent definition,
- fixed multi-agent orchestration → procedure/workflow,
- product or API reference → documentation,
- one-time task detail → conversation or task plan.

Avoid skills that merely restate common knowledge, duplicate a stronger skill,
or exist only to wrap one trivial command.

## Design the package

A common layout is:

```text
skill-name/
├── SKILL.md
├── references/    optional detailed guidance
├── scripts/       optional deterministic helpers
└── assets/        optional output inputs/templates
```

Use only directories supported by the target runtime. Keep `SKILL.md` sufficient
to choose and execute the main workflow; move large variant-specific or reference
material into directly linked files. Avoid deep chains of references.

### Frontmatter

Use only verified fields. At minimum, runtimes commonly require a stable name and
a trigger description, but even these constraints must be checked.

Write the description to discriminate intent:

- state what the skill helps accomplish,
- name realistic triggering situations,
- include important exclusions when adjacent skills could compete,
- avoid catch-all language such as “whenever anything relates to X,”
- do not list every keyword or optimize for triggering at the expense of precision.

The directory name and declared name should match unless the runtime explicitly
supports aliases.

### Instructions

- Use direct, imperative language and explain reasoning where it helps adaptation.
- Put trigger guidance in metadata when the runtime selects skills from metadata.
- Match specificity to risk: principles for judgment-heavy work, concrete checks
  for fragile or safety-sensitive work.
- Define boundaries, failure behavior, and verification—not only the happy path.
- Respect repository conventions rather than imposing a preferred stack.
- Keep examples illustrative and label platform assumptions.
- Never assume Bash, `/tmp`, `~/Downloads`, browser launching, Python, Node,
  Docker, or a particular path separator. Detect or document prerequisites and
  provide a safe fallback.
- Never claim telemetry, token counts, timing, transcripts, or completion events
  are available unless the active runtime exposes them.

### Bundled resources

Add a script when it replaces repeated deterministic work. Prefer standard-library
implementations when practical, validate inputs, avoid destructive defaults, and
support paths containing spaces. Document runtime and OS requirements. Do not
bundle a validator or packager merely to impose one runtime's schema or archive
format; use the target platform's supported tooling when available.

Add references for material loaded only in certain variants. Add assets only when
they are actual inputs to generated output. Remove obsolete bundled files so a
future agent does not follow contradictory workflows.

Review licenses and attribution before copying or modifying third-party resources.
Do not remove required notices merely to make a package look vendor-neutral.

## Create or revise safely

For an existing skill:

1. Read its `SKILL.md` and relevant bundled resources completely.
2. Search for external references to its name, path, schemas, and scripts.
3. Check version-control status and preserve unrelated user work.
4. Snapshot the original only when comparison or rollback needs it; use a
   platform-appropriate writable workspace, not a hard-coded temporary path.
5. Preserve the public name unless a deliberate migration updates every consumer.
6. Remove stale resources only after confirming they are unreferenced or updating
   those references.

For a new skill, start with the smallest useful draft. Do not generate evaluation
infrastructure, viewers, packaging, or provider adapters unless they add value for
the requested skill.

## Validate in layers

Use the strongest checks supported by the environment:

1. **Structure:** required files exist; names and links resolve.
2. **Metadata:** frontmatter parses and uses supported fields and limits.
3. **Content:** instructions are internally consistent, scoped, safe, and free of
   stale runtime assumptions.
4. **Resources:** scripts parse or compile, help text works, sample inputs are
   handled, and referenced assets exist.
5. **Portability:** test or inspect required OS/shell/runtime variants; distinguish
   verified support from documented limitations.
6. **Behavior:** exercise realistic tasks and near-miss trigger cases.
7. **Regression:** verify existing integrations and references after migrations.

A static validator cannot prove that a skill triggers correctly or improves task
quality. Report what was and was not tested.

## Choose an evaluation level

Scale evaluation to risk and objectivity.

### Level 0 — review only

Use for tiny wording fixes or low-risk subjective guidance. Review metadata,
workflow clarity, conflicts, references, and portability.

### Level 1 — scenario checks

Use for most skills. Define several realistic scenarios:

- expected trigger,
- important near-miss that should not trigger,
- normal successful task,
- missing-input or constrained-environment case,
- safety or failure case when relevant.

Run them manually or through the active runtime. Record observable results and
human feedback.

### Level 2 — comparative evaluation

Use when replacing a consequential skill or when the user asks whether the new
version is better. Compare the candidate with the original or no-skill baseline
using the same task inputs and equivalent runtime settings. Randomize/blind review
when supported. Prefer deterministic checks for objective artifacts and human
review for judgment-heavy outputs.

Do not require parallel agents. Run concurrently only when the runtime supports it
and isolation is reliable; serial execution is valid. Do not require a browser:
present results in chat, files, a native UI, or a static report according to
available capabilities.

Read [the portable evaluation workflow](references/evaluation.md) and the
[optional JSON interchange format](references/schemas.md).

## Improve without overfitting

Diagnose why the skill helped or hurt:

- Did it trigger for the right intent?
- Did the agent follow the useful parts?
- Did instructions cause unnecessary work or block sound judgment?
- Are failures caused by the skill, runtime limitations, or the test itself?
- Are expectations discriminating, or do both candidate and baseline pass?

Generalize improvements across the skill's real domain. Remove instructions that
do not change behavior, consolidate repeated logic into a resource when useful,
and avoid adding narrow rules solely to satisfy one test prompt.

## Runtime adapters

Keep the core workflow provider-neutral. Read
[runtime adapters](references/runtime-adapters.md) only when configuring
execution for a specific harness. An adapter may describe
how Pi, Claude, Codex, or another runtime exposes skills, agents, tools, or output,
but it must be capability-checked and optional. Provider absence must degrade to
manual review rather than make skill authoring impossible.

## Completion report

Report concisely:

- skills and resources added, changed, moved, or removed,
- trigger/scope decisions,
- validation and evaluation performed,
- compatibility or portability limitations,
- unresolved risks or recommended follow-up.

Do not claim improvement solely because the file became longer, more detailed, or
passed a syntax check.
