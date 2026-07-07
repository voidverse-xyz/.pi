# pi-browse

`/browse-files` — a native Pi TUI file & directory tree browser with **add-to-chat**.

## What it does

A full-screen two-pane overlay:

- **Left — tree.** A lazy filesystem tree rooted at the working directory. Directories
  expand/collapse on demand (children are read only when first opened), so `/browse-files`
  never walks the whole tree up front. Everything is shown — dotfiles, ignored paths,
  `node_modules`, `.git` — no filtering.
- **Right — preview.** Selecting a file shows its contents (with a line-number gutter
  and a movable line cursor); selecting a directory shows its listing.

## Add to chat

The whole point: gather `@`-mentions into the input editor without sending, then type
your prompt around them. Pressing **`a`** appends a reference (space-separated, with a
trailing space) to whatever you've already typed:

| Where | `a` adds |
|-------|----------|
| A file (tree) | `@path/to/file` |
| A directory (tree or preview) | `@path/to/dir/` |
| A line range (file preview, after selecting) | `@path/to/file:12` or `@path/to/file:12-40` |

To add a line range: open a file into the preview, `Tab` into it, press **`s`** to drop a
selection anchor at the cursor line, move to extend, then **`a`**. Press `s` again to
clear the selection. With no selection, `a` in the preview adds the whole file.

The overlay stays open so you can add several references in one pass.

## Keys

**Tree pane**

| Key | Action |
|-----|--------|
| `↑`/`↓` `j`/`k` | move |
| `→`/`l` | expand directory |
| `←`/`h` | collapse / jump to parent |
| `Enter` | expand dir, or open file into preview |
| `a` | add selected file/dir to chat |
| `Tab` | focus the preview pane |
| `g`/`G`, `PgUp`/`PgDn`, `Ctrl+U`/`Ctrl+D` | scroll |
| `Esc` / `q` | close |

**Preview pane (file)**

| Key | Action |
|-----|--------|
| `↑`/`↓` | move the line cursor |
| `s` (or `v`) | start / clear a line selection |
| `a` | add the selected range (or the whole file) to chat |
| `Tab` / `Esc` / `←` | back to the tree |
| `q` | close |

## Install

This is a Pi package. Enable it by adding its absolute path to
`~/.pi/agent/settings.json` → `packages[]`, then `/reload`:

```
/home/john/Agents/Documents/Configs/PiAgent/packages/pi-browse
```
