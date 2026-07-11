# Notify User

`notify-user` registers the LLM-callable `notify_user` tool — the agent's way to
make sure the user actually *sees* something: a status notice, completed work,
warnings about risks/caveats, or errors for things that failed.

The full notice renders as a padded, banded block appended after the agent
finishes (after the assistant's final message):

- the `title` band is colored by **severity** — muted green for
  `success`, yellow for `warning`, red for `error`, and the normal
  custom-message background for `info` — with a right-aligned `[severity]` tag
  (omitted for plain info)
- `successes` ("Done") uses a muted green background
- `info` uses a muted blue background
- `warnings` uses a muted yellow background
- `errors` uses a muted red background

`severity` (`success | info | warning | error`) can be set explicitly; when
omitted it is inferred from the sections: errors > warnings > successes > info.
It also sets the urgent-toast level (success maps to info — the toast API has
no success level).

Set `urgent: true` to also pop an immediate toast notification the moment the
tool is called — for warnings/errors the user should see before the turn ends
(mid-stream transcript injection isn't possible for extensions, but `ui.notify`
is; the block still lands at end of turn).

The tool-call and result rows only show non-zero section counts ("2 warnings,
1 error"), so a notice *about* errors never reads as the tool itself failing.

All fields are optional:

```json
{
  "title": "Run summary",
  "severity": "success",
  "successes": ["Migrations applied cleanly."],
  "info": ["Updated the extension manifest."],
  "warnings": ["TypeScript is not installed on PATH."],
  "errors": [],
  "urgent": false
}
```
