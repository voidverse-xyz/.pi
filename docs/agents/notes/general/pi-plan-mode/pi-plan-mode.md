# Pi Ask, Discuss, and Plan modes

## Scope

`Configs/PiAgent/packages/pi-plan/` implements four mutually exclusive main-agent states:

1. **Off** — normal unrestricted Pi with the pre-mode active tool set.
2. **Ask** — quick chat, normally 1–4 short sentences, with trusted built-in read-only lookup tools.
3. **Discuss** — normal response length with trusted read-only lookup plus `ask_user` and `show_files`.
4. **Plan** — project research, optional read-only delegated research, and authorized Markdown plan saving.

`/ask`, `/discuss`, and `/plan` toggle their mode or enable it and submit a task. `Shift+Tab` cycles `Off → Ask → Discuss → Plan → Off`. Mode changes are idle-only.

## State and lifecycle

The extension persists one `plan-mode.state` custom entry containing the active mode, Plan template override, authorized plan root/path, and addresses of read-only subagents created in Plan mode. State follows the active branch across reload, resume, fork, and `/tree`. The parser accepts the former `{ enabled: boolean }` shape and migrates it to `plan` or `off`.

Entering the first restricted mode snapshots the current active tools. Transitions among Ask, Discuss, and Plan filter from the same snapshot. Returning Off restores the snapshot. `session_shutdown` restores it before runtime replacement so the next extension instance does not accidentally snapshot an already-filtered set.

## Prompt behavior

`before_agent_start` appends a host-controlled block for the active restricted mode:

- Ask requires a direct 1–4 sentence response with no padding or extra sections.
- Discuss permits normal response length and organization but forbids implementation and delegation.
- Plan loads the shared `Skills/plan/` boundaries and at most one supplemental tagged planning template.

Ask brevity is a prompt-level rule because the extension API does not expose a per-mode provider output-token setting. Tool restrictions are independently enforced by the host.

## Template routing

The base `Skills/plan/` skill defines Plan's planning, delegation, and save boundaries. Supplemental loaded skills become candidates only when their top-level frontmatter contains `plan-template: true`. Automatic mode excludes `disable-model-invocation` skills, caps the catalog at 20 entries and descriptions at 1024 characters, and lets the model read exactly one matching `SKILL.md` through Pi's bounded progressive-disclosure flow.

`/plan --skill <name> <task>` is explicit user invocation: it may select a disabled template, validates the tag/readability, and caps direct injection at 50 KiB. If a forced template disappears, persisted selection is cleared before automatic fallback. A selected template's required output layout overrides the base default layout.

The `resources_discover` hook contributes only tagged directories from the shared `Skills/` root (bounded to 100), currently `general-planning` and `software-implementation-planning`.

## Main-agent enforcement

Every restricted-mode tool must match exact expected built-in or local-package provenance. Active-tool filtering reduces the model-visible surface; a default-deny `tool_call` guard blocks disallowed or colliding tools even when another extension activates them later.

| Mode | Allowed tool classes |
|---|---|
| Ask | trusted built-in `read`, `grep`, `find`, `ls` |
| Discuss | Ask tools plus trusted local `ask_user`, `show_files` |
| Plan | read tools, previously active `ask_user`/`show_files`/`todo_write`, `save_plan`, trusted local `subagent_*` tools |

Bash, general file mutation, team tools, workflow tools, and unknown custom tools are unavailable in all restricted modes.

## Plan subagent enforcement

Plan may delegate only through the trusted local `pi-subagents` package. The guard applies a second policy to those calls:

- typed agents are rejected;
- ids and persistent lifetime are rejected;
- accepted spawns are normalized in-place to fresh ad-hoc one-shot workers with coding tools exactly `read`, `grep`, `find`, and `ls`;
- a worker address becomes Plan-authorized only after a successful spawn result reports `created: true` and an `adhoc/<id>` address;
- authorized addresses persist branch-locally;
- send, steer, cancel, retire, detailed status, and explicit await targets may reference only authorized addresses;
- await-all is rejected because it could consume unrelated subagent work;
- successful retire removes the address from the authorized set.

Fresh one-shot addresses prevent a Plan spawn from waking a pre-existing persistent ad-hoc worker whose definition might contain mutation tools. The subagent runtime itself provides only `report` beyond the forced coding tools, so Plan workers cannot nest or peer-message.

## Plan save exception

The model derives a project-relative Markdown path from loaded project instructions. `save_plan` asks the user to authorize the first exact canonical-project-root/path pair on a session branch and asks again when the project or path changes. Revisions to the authorized path replace the whole document atomically.

Path handling rejects absolute paths, traversal, control characters, non-Markdown targets, symlink components, and non-regular existing targets. Writes are bounded and queued through Pi's shared file-mutation queue. Existing plans preserve permission bits and use an fsynced same-directory temporary file followed by rename; new targets use a create-only hard link so a file that appears after authorization is not overwritten. Confirmation fails closed without UI and times out after two minutes over RPC.

## Boundary

These controls constrain model-visible Pi tools, not the operating system. They do not stop user-entered shell commands, manually invoked slash commands, subagents already running before a mode transition, other extension background work, or external processes. Use an OS-level read-only mount/container when those actors are in scope.

## Verification

Automated policy, save, and template tests:

```bash
node --test \
  Configs/PiAgent/packages/pi-plan/extensions/plan/policy.test.ts \
  Configs/PiAgent/packages/pi-plan/extensions/plan/save.test.ts \
  Configs/PiAgent/packages/pi-plan/extensions/plan/templates.test.ts
```

Offline RPC smoke coverage should verify:

1. `get_commands` includes `ask`, `discuss`, `plan`, and `skill:plan` with no `extension_error`.
2. `/ask on`, `/discuss on`, `/plan on`, and `/plan off` publish the expected status/notification sequence.
3. `get_entries` contains branch-local mode states in that same sequence.
