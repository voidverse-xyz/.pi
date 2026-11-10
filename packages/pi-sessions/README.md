# pi-sessions

Provides `/sessions` as an alias for Pi's `/resume` command.

It opens Pi's native session selector, including search, current/all scope,
sorting, named-session filtering, rename, and delete controls. Selecting a
session switches through `ctx.switchSession()`, so normal session lifecycle
hooks still apply.

```text
/sessions
```
