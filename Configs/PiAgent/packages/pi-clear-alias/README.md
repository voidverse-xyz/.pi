# pi-clear-alias

Provides `/clear` as a muscle-memory alias for Pi's `/new` command.

After loading this package, run:

```text
/clear
```

to start a new Pi session. Existing session-switch hooks still run because the extension uses `ctx.newSession()`.
