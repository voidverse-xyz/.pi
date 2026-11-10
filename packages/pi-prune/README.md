# pi-prune

Provides `/prune`, which replaces the current session with a fresh session and
then removes the previous session file.

```text
/prune
```

The command uses Pi's session replacement API, so lifecycle guards can cancel the
switch before anything is deleted. After the new session is active, it moves the
old session to the system trash when the `trash` CLI is available and falls back
to permanent deletion otherwise.

If the old session cannot be removed, the new session remains active and Pi shows
an error. In-memory sessions simply switch to a new session.
