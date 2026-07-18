# Theme-Aware Syntax Highlighting in a Pi Custom Preview

Use this procedure when a Pi extension displays raw source code in a custom TUI component and should match fenced-code highlighting in chat.

## Preferred Approach

1. Import `getLanguageFromPath()` and `highlightCode()` from `@earendil-works/pi-coding-agent`.
2. Detect the language from the real file path. Do not enable automatic language guessing for unknown extensions; it can color ordinary prose incorrectly.
3. Highlight the complete file in one call so multiline constructs are tokenized correctly.
4. Keep raw source lines separately for search, copy/yank, selections, line numbers, and persisted data.
5. Use highlighted lines only when their count equals the raw line count. On exceptions or mismatches, render plain text.
6. Preserve the highlighter's ANSI foreground colors. Prefer a selected-row background for the cursor line, an underline for search matches, and distinct row backgrounds for selections or annotated regions.
7. Pass highlighted strings through ANSI-aware utilities such as `truncateToWidth()`, `visibleWidth()`, and `wrapTextWithAnsi()`.

## Cache and Theme Lifecycle

`highlightCode()` returns strings with the active theme's ANSI colors already embedded. A cached result therefore becomes stale when the user changes themes.

Separate two invalidation paths:

- **State/navigation rerender:** clear only the component's final width/height render cache.
- **TUI `invalidate()`:** clear the final cache and rebuild any pre-colored syntax output. Also invalidate nested components, such as `Markdown`, that cache themed rendering.

This avoids re-highlighting a whole file on every cursor movement while still responding correctly to theme changes.

## Verification Checklist

- A known-language fixture contains multiple token color sequences.
- Unknown file types retain a readable plain fallback.
- Cursor, search, selection, and annotated-region states remain visible.
- Raw line indices still match gutters, selections, and copied ranges.
- Theme switching changes the highlighted ANSI output after invalidation.
- Every rendered line respects the supplied component width.
- Large-file preview limits remain in effect before highlighting.
- The extension entry module loads through Pi's normal TypeScript loader.
