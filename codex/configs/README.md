# Codex Config

This folder stores Codex configuration that should live with the agent library.

The live Codex config path, `~/.codex/config.toml`, may be a symlink to
`codex/configs/config.toml` on a configured host. The local config file is
ignored by Git because it can contain machine-specific paths and trust settings.

Do not copy Codex auth files, sessions, logs, caches, SQLite state, or history
files into this folder.
