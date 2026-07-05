# User Summary

`user-summary` registers the LLM-callable `user_summary` tool.

The tool shows a compact TUI panel with optional summary content and colored
message bands:

- `info`
- `warnings`
- `errors`

All fields are optional:

```json
{
  "title": "Run summary",
  "summary": "Finished the main task.",
  "info": ["Updated the extension manifest."],
  "warnings": ["TypeScript is not installed on PATH."],
  "errors": []
}
```

Use `/user-summary` to show a local demo panel. The tool waits until the user
presses Enter or Esc, then returns whether the panel was viewed or dismissed.
