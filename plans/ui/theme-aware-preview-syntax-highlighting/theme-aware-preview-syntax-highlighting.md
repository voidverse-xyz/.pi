# Theme-aware preview syntax highlighting

Reusable procedure for custom source-code previews that should match the host application's fenced-code highlighting.

## Preferred approach

1. Detect the language from the real file path. Do not enable automatic guessing for unknown extensions; it can color ordinary prose incorrectly.
2. Highlight the complete file in one pass so multiline constructs are tokenized correctly.
3. Keep raw source lines separately for search, copy/yank, selections, line numbers, and persisted data.
4. Use highlighted lines only when their count equals the raw line count. On exceptions or mismatches, render plain text.
5. Preserve highlighter foreground colors. Use background, underline, or annotation styling for cursor lines, matches, and selections.
6. Pass highlighted strings through ANSI-aware or span-aware width, truncate, and wrap helpers.

## Cache and theme lifecycle

Highlighted output often embeds theme-specific colors. Separate two invalidation paths:

- **State/navigation rerender:** clear only final width/height layout cache.
- **Theme or full UI invalidation:** clear final layout cache and rebuild pre-colored syntax output. Also invalidate nested renderers that cache themed content.

This avoids re-highlighting on every cursor movement while still responding correctly to theme changes.

## Verification checklist

- Known-language fixtures contain multiple token color spans.
- Unknown file types retain a readable plain fallback.
- Cursor, search, selection, and annotation states remain visible.
- Raw line indices still match gutters, selections, and copied ranges.
- Theme switching changes highlighted output after invalidation.
- Every rendered line respects component width.
- Large-file preview limits apply before highlighting.
