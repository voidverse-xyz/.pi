# Pi Plan mode implementation

## Scope

`Configs/PiAgent/packages/pi-plan/` implements host-managed Plan mode for the main Pi agent. `/plan <task>` enables the mode, offers tagged Plan skills for automatic model selection, and submits the task; `/plan --skill <name> <task>` forces a tagged template. `/plan off` restores the prior active-tool set. The mode, explicit skill selection, and authorized plan path follow the active session branch.

## Template routing

The base `Skills/plan/` skill always defines the mode and save boundary. Supplemental loaded skills become candidates only when their top-level frontmatter contains `plan-template: true`. Automatic mode excludes `disable-model-invocation` skills, caps the catalog at 20 entries and descriptions at 1024 characters, and lets the model read exactly one matching `SKILL.md` through Pi's bounded progressive-disclosure flow. Explicit `--skill` is treated as user invocation: it may select a disabled template, but validates the tag/readability and caps direct system-prompt injection at 50 KiB. If a forced template disappears, its persisted selection is cleared before automatic fallback. A selected template's required output layout overrides the base default layout.

The extension's `resources_discover` hook recursively contributes only tagged directories from the shared `Skills/` root (bounded to 100), currently `general-planning` and `software-implementation-planning`; it does not load unrelated shared skills. Tagged skills from other normal Pi skill locations are discovered from `systemPromptOptions.skills` without further extension changes.

## Enforcement

Plan mode snapshots the model-visible tools, enables Pi's core read-only tools plus `save_plan`, and retains already-active approved companion UI tools. Allowed names must also match their exact expected built-in or local-package provenance. A `tool_call` default-deny guard remains authoritative if another extension later activates or overrides a tool. Bash, general file mutation, and subagent tools are excluded.

This is not an OS-level filesystem freeze. User-entered shell commands, manually invoked slash commands, already-running child agents, extension background work, and external processes remain outside its boundary. Static symlinks are rejected, but path-based Node filesystem calls retain a parent-directory race against concurrent external mutation; use a read-only mount/container when that actor is in scope.

## Plan save exception

The model derives a project-relative Markdown path from loaded project instructions. `save_plan` asks the user to authorize the first exact canonical-project-root/path pair on a session branch and asks again when the project or path changes. Revisions to the authorized path replace the whole document atomically.

Path handling rejects absolute paths, traversal, control characters, non-Markdown targets, symlink components, and non-regular existing targets. Writes are bounded and queued through Pi's shared file-mutation queue. Existing plans preserve permission bits and use an fsynced same-directory temporary file followed by rename; new targets use a create-only hard link so a file that appears after authorization is not overwritten. Confirmation fails closed without UI and times out after two minutes over RPC.

## Verification

Pure policy and filesystem tests live beside the extension:

```bash
node --test \
  Configs/PiAgent/packages/pi-plan/extensions/plan/policy.test.ts \
  Configs/PiAgent/packages/pi-plan/extensions/plan/save.test.ts \
  Configs/PiAgent/packages/pi-plan/extensions/plan/templates.test.ts
```

An offline RPC `get_commands` smoke test should report both `plan` and `skill:plan`, confirming the package and shared skill load successfully.
