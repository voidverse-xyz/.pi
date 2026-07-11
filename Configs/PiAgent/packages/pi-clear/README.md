# pi-clear

Provides `/clear` as a muscle-memory alias for Pi's `/new` command.

It creates the replacement session through `ctx.newSession()`, so session lifecycle
hooks—including `pi-run-guard` confirmation while an agent is active—still apply.

```text
/clear
```
