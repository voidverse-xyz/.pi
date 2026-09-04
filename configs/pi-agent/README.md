# Pi Agent Packages

Active package-backed Pi extensions and their project documentation live here.
The repository root—not this directory—is the portable global configuration
cloned to `~/.pi` (or directly to `~/.pi/agent`, where the nested `agent/` shims
are dormant).

- `packages/`: active local Pi packages enabled through relative entries in root
  `settings.json`.
- `docs/`: PiAgent-specific plans, notes, and implementation records.
- `MANIFEST.md`: active package and resource inventory.

Global skills, keybindings, and definitions shared by Pi Subagents and Pi Teams
live at root `skills/`, `keybindings.json`, and `subagents/`; `agent/` exposes
them to Pi when the checkout sits one level above the effective agent dir. Keep
machine-local and sensitive state outside the tracked tree.

## GPT-6 Astra custom model

When Pi's built-in Codex catalog does not yet list `gpt-6-astra`, use
[the custom model example](gpt-6-astra.example.json) with Pi's
[custom provider configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).
Merge its model entry into the `openai-codex` provider's `models` array,
preserving other provider and model entries. If Astra is already present,
update that entry instead of adding a duplicate.

The example uses the existing Codex subscription login and declares text/image
input, reasoning levels from `low` through `max`, a 1,050,000-token context
window, and a 128,000-token output limit. These capabilities follow the
[OpenAI model specification](https://developers.openai.com/api/docs/models/gpt-6-astra).
Service-side access and limits still depend on the account and rollout.

Open `/model` again to reload the configuration and select `gpt-6-astra`.
Adding the entry does not change the default model or grant model access.
