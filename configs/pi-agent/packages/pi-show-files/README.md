# pi-show-files

`show_files` — an **LLM-callable tool** (like `ask_user`) that presents a curated,
annotated set of files to the user in a full-screen native TUI. The agent calls it
when the user asks *"which files implement X?"*, *"where are the docs for Y?"*, or
wants a guided tour of part of the codebase.

## What the agent supplies

- A presentation `title` and optional `summary`.
- `files[]`, in most-important-first order, each with:
  - `path` — relative to the session cwd (absolute accepted). A directory is a
    valid curated item and becomes a **constrained browse root** (see
    "Directories" below).
  - `title` — short label for the list (defaults to the file name).
  - `description` — why this file matters; rendered above the preview.
  - `group` — optional section heading (consecutive files sharing a group render under it).
  - `regions[]` — 1-based line ranges to highlight, each with an optional `note`.
    The preview opens on the first region; `n`/`p` jump between them; the note of
    the region under the cursor shows in the pane label.

Missing paths are not dropped: they're shown dimmed with a "(missing)" marker and
reported back so the agent can correct itself. If *every* path is missing the tool
errors immediately instead of showing an empty panel.

## What the user can do

- Browse the grouped list (left) and preview with highlights (right); opened files
  get a `·` marker. Raw source previews use Pi's theme-aware syntax highlighter —
  the same token colors as fenced code in chat — while line numbers, regions,
  selections, search matches, and cursor navigation remain intact.
- `/` — search: fuzzy-filters the file list when the list has focus (agent order
  preserved, group headings kept only while they have members), substring-searches
  the file content when the preview has focus (`n`/`p` jump matches while a search
  is active; Esc clears it). Enter keeps the query, Esc in the input cancels it.
- `r` — toggle rendered↔raw for Markdown/HTML previews. These render by default
  *unless* the spec has regions (regions reference raw line numbers). Press `r` for
  the source when fidelity matters.
- **HTML** (`.html` / `.htm`) rendered view is **browser-assisted when possible**.
  On open it kicks off a **local headless-Chromium snapshot** (Playwright's cached
  Chromium, or a system Chrome/Chromium — no new dependency; nothing is added if
  none is present). The render is strictly local: the file loads over `file://`,
  outbound requests are forced through an unreachable loopback proxy, with DNS
  resolution and background networking blocked as additional layers; the browser
  is spawned with an argv array (never a shell). A banner reports the result:
  - **rendered ok** → ` Rendered · o open in browser` plus the snapshot PNG path
    and pixel dimensions. The snapshot *can't* paint inline (terminal overlay — see
    Images below), so the pane shows the best-effort text and `o` opens the page in
    your system browser for full fidelity (CSS, layout, tables, embedded images).
  - **no browser / render failed** → a clear ` … best-effort text` notice, with
    `o` still offered to open the page in your browser.
  Either way you get readable text (a dependency-free tag strip), never a blank
  pane, and `r` still toggles to raw source. Images embedded in the HTML are only
  visible in the external/browser render, not the in-terminal text.
- **Images** (`png`, `jpg`/`jpeg`, `gif`, `webp`) show as an **info card** — path,
  MIME type, pixel dimensions, and file size — headed by **"Terminal image preview
  unavailable."** They are not drawn inline: the panel is a full-screen TUI
  *overlay*, and the overlay compositor rewrites each line (padding + resets), which
  corrupts kitty/iTerm2 graphics escape sequences; inline terminal images only
  survive in the base transcript, not in an overlay. The card also says whether the
  terminal has a graphics protocol at all, so the preview is never a blank pane. `a`
  adds the image as an `@path` mention; open the path in an image viewer to see it.
- `a` — **add a mention** to the chat editor, without sending (same pattern as
  pi-browse). In the raw preview it adds the **most specific** mention available:
  an `s`/`v` selection → `@path:start-end`; else the highlighted region under the
  cursor → `@path:regionStart-regionEnd`; else the cursor line → `@path:line`. The
  footer says which (`a add range` / `a add region` / `a add line`). A directory
  adds `@dir/` from the list, or the selected child entry's mention while browsing;
  rendered-markdown previews add the plain `@path`. Adding the **same** mention
  twice is a no-op — it isn't appended again and you get an "Already added" notice.
- `c` — **copy a mention** (reference) to the host clipboard. With an active `s`/`v`
  selection in the raw preview it copies that range's `@path:start-end` mention
  (`Copied mention: @path:3-6`); otherwise it copies the mentions added so far with
  `a`, space-joined (`Copied N mentions`).
- `y` — **yank text** (the actual content) to the host clipboard: the selected
  lines if a selection is active, else the highlighted region under the cursor, else
  the current line — notified as `Copied N lines of text`. A rendered Markdown/HTML
  preview yanks the file's source text.
- `m` — type a free-text note to the agent in an embedded editor. Notes are **`m`
  everywhere** — never `n`, which (with `p`) stays bound to region/match navigation.
- `q` — close. `Esc` remains a stateful fallback that first clears an active
  filter/search/selection, or steps back up while browsing a directory.

## Directories

A directory in `files[]` is a **constrained browse root**. Selecting it and
pressing Enter focuses a directory preview on the right that you can navigate:

- `↑↓` — select a child entry (the pane label shows `· browse [n/total]`);
- `Enter` / `→` — descend into a child directory, or preview a child file;
- `h` / `←` / `Backspace` — go **up** one level; at the curated root this
  returns focus to the left list (`Esc` remains a fallback). Navigation is **clamped to the curated root** —
  you can never browse above the directory the agent chose;
- `..` — the first row when you've descended; select it and Enter (or just go up)
  to pop back to the parent.
- `a` — add the **selected** entry's mention: `@dir/` for a subdirectory (directory
  mentions always end with `/`), `@path` for a file.

Child files opened while browsing are reported back in the result's `opened`, and
mentions added while browsing land in `added`, same as curated files. For a
full-tree browser outside a curated set, the separate **pi-browse** extension
(`/browse`) still applies.

## Two-way result

The tool result tells the agent what actually happened: which files the user
opened, which mentions they added to chat, and their note — so the agent can
follow up on what the user cared about instead of re-explaining everything.
"User closed without opening any file previews" is also honest, useful feedback.

## Command

`/show-files` reopens the session's last presentation. Since a command has no
tool result to carry a note back, a note typed there is staged into the chat
editor instead of being dropped. A presentation forwarded up from a subagent
becomes the session's "last" one too (deliberate: it's the most recent thing
that was on screen), so `/show-files` reopens it — clobbering the parent's own
previous presentation.

## Headless subagents

With the optional `ipc` extension installed (reached over `pi.events`, no
import — dropping it can't break this extension's load), a headless subagent
forwards the presentation up to the session that owns the TUI:

- the panel appears on the **parent's** screen, with a header naming the asking
  subagent chain (`worker → reviewer is showing files:`);
- paths are pre-resolved to absolute against the child's cwd, so child-relative
  specs present correctly regardless of the parent's cwd;
- `a`-mentions land in the **parent's** chat editor (parent-relative), and the
  child's tool result says so explicitly;
- the outcome (opened / added / note) is relayed back to the child faithfully;
- parallel forwarding subagents serialize (pi-ipc's UI lock) — panels appear one
  after another.

Without `ipc` (or with no parent channel) the tool returns a graceful error
telling the agent to describe the files in prose instead.
