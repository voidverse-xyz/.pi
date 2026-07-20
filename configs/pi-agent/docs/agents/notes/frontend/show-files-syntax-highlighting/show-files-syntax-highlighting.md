# Show Files Syntax Highlighting

## Problem

The `show_files` raw preview rendered every source line with one foreground color. Fenced code in Pi chat already uses Pi's theme-aware token highlighter, so the panel looked noticeably flatter than the transcript.

## Root Cause

`extensions/show-files/panel.ts` rendered raw text line by line and applied `dim`, `text`, or `accent` to the complete line. It never called Pi's exported `getLanguageFromPath()` and `highlightCode()` APIs.

## Implementation

- Detect the language from the previewed file path and highlight the complete source text with Pi's built-in highlighter.
- Keep original `fileLines` unchanged for searching, line numbers, selections, region mapping, mentions, and copied text.
- Accept highlighted output only when its line count exactly matches the raw source. Otherwise, fall back to the existing plain rendering so cursor and region indices cannot drift.
- Preserve token foreground colors. Use a `selectedBg` tint for the active cursor line, underline search matches, and retain row backgrounds for selections and annotated regions.
- Separate ordinary render-cache clearing from TUI invalidation. Navigation rerenders stay cheap, while theme invalidation rebuilds pre-colored source lines and invalidates the Markdown component.
- Leave unknown file types in the existing plain-text presentation rather than using unreliable language auto-detection.

## Verification

A runtime smoke test loaded the TypeScript extension through Pi's Jiti loader, instantiated the panel around a TypeScript fixture, and verified:

1. token-level ANSI styling appeared in the source row;
2. active-line and annotated-region backgrounds remained present without erasing token colors;
3. changing themes and invalidating the panel rebuilt the syntax colors;
4. every output row stayed within the requested width;
5. the panel returned exactly the terminal's requested height; and
6. the complete extension entry module still loaded successfully.

## Changed Files

- `configs/pi-agent/packages/pi-show-files/extensions/show-files/panel.ts`
- `configs/pi-agent/packages/pi-show-files/README.md`
- `configs/pi-agent/packages/pi-show-files/package.json`
