# Codex Plugins

Local Codex plugin sources and marketplace metadata live here.

Use this layout for marketplace-backed plugins:

- `marketplace.json`: workspace plugin marketplace metadata.
- `plugins/<plugin-name>/`: plugin source directory.

Each plugin source directory should include a `.codex-plugin/plugin.json`
manifest. Marketplace entries should point to `./plugins/<plugin-name>`.
