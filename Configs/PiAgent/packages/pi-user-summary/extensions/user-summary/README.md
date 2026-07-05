# User Summary

`user-summary` registers the LLM-callable `user_summary` tool.

The tool queues a compact transcript summary that is appended after the agent
finishes, so it appears after the assistant's final message. The custom renderer
shows optional summary content and padded, muted message bands:

- `summary` uses the normal custom-message background
- `info` uses a muted blue background
- `warnings` uses a muted yellow background
- `errors` uses a muted red background

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

Use `/user-summary` to append a local demo message immediately.
