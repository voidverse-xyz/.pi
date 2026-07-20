# Portable Pi global configuration repository

## Goal

Maintain a Git repository that can be cloned directly to `~/.pi/agent` while keeping portable Pi resources under version control and all credentials and runtime state local.

## Recommended layout

```text
~/.pi/agent/
├── AGENTS.md
├── README.md
├── settings.json
├── keybindings.json
├── skills/
├── extensions/              # optional direct extensions
├── prompts/                 # optional prompt templates
├── themes/                  # optional direct themes
├── subagents/               # extension-specific type definitions
├── teams/                   # extension-specific type definitions
├── packages/                # optional local package sources
└── <shared-source-trees>/    # ignored by Pi unless configured
```

Package sources may live elsewhere inside the repository. Global `settings.json` resolves relative resource and local-package paths from `~/.pi/agent`, so use `./...` entries rather than home paths.

## Tracked versus local

Track only reviewed source and portable preferences:

- `settings.json` with portable relative paths
- `keybindings.json`
- extensions, packages, skills, prompts, themes, and agent definitions
- setup documentation and sanitized examples

Ignore and never commit:

- `auth.json`, OAuth data, private model/provider overrides, tokens, and environment files
- sessions, trust decisions, caches, managed npm/Git installs, downloaded binaries, and logs
- extension-owned mutable settings, audit logs, databases, and temporary exports
- private keys and host/editor artifacts

Treat every change to tracked `settings.json` as source review because Pi can update the file interactively.

## Safe migration

1. Inventory the existing global directory by filename and type without printing credential values.
2. Classify each item as portable source, private runtime state, generated state, or inactive legacy material.
3. Move inactive legacy material into an ignored temporary quarantine; do not delete it during migration.
4. Convert absolute resource/package paths to paths relative to the repository root.
5. Copy fixed-path extension libraries into their documented global directories as ordinary files; avoid linked definitions when extensions protect against symlink or hard-link mutation.
6. Add root-anchored ignore rules before restoring any private files.
7. Verify from a temporary tracked-files-only clone with a separate Pi agent directory.
8. Back up the live global directory privately, clone the repository into place, then restore only ignored local state with restrictive permissions.

## Verification checklist

1. `git ls-files` contains no credentials, sessions, logs, databases, managed installs, private keys, or runtime state.
2. `git ls-files -s` contains no unexpected symlink entries.
3. Every configured local package path is relative, exists, and avoids archive/quarantine trees.
4. Representative private/runtime paths are ignored by `git check-ignore`.
5. JSON, skill frontmatter, extension loading, and package tests pass.
6. An offline Pi smoke test using a temporary agent directory discovers the expected resources without credentials.
7. The temporary quarantine has an explicit source-path report and remains untracked.
8. `git diff --check` and a final status review pass before any commit.

## Cutover and rollback

Stop Pi, make a private backup of the existing global directory, and preserve the session tree without flattening it. Clone into the empty global path and restore only ignored files such as credentials and sessions. Keep the backup until startup and resource discovery pass. Rollback is a directory swap; never merge an old settings file over the portable tracked version.
