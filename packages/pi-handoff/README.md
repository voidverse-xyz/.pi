# pi-handoff

Provides `/handoff [focus]`, which summarizes the active session branch and
creates a fresh continuation session containing only the editable handoff
summary.

```text
/handoff
/handoff Continue with the remaining authentication fixes
```

The optional focus tells the summarizer what the new session should prioritize.
While the summary is generated, the loader shows an estimated input-token count
and the 6,000-token output limit. Provider-reported input, output, cache, and
total usage is shown when generation finishes and stored with the handoff
message details. The estimate uses Pi's four-characters-per-token heuristic;
the completed usage is authoritative when the provider reports it.

Before switching sessions, the generated summary opens in an editor for review.
Failed or output-limited generations are rejected rather than accepted as complete
summaries. Cancelling the editor or session replacement leaves the original session active.
The new session records the previous session as its parent and retains the old
session unchanged. Persisted handoffs are saved immediately, so the edited summary
survives exit or another session switch without an additional assistant reply.
In-memory sessions remain in memory. It does not automatically run another model
turn after the switch.

Run `node --test packages/pi-handoff/test/handoff.test.mjs` for
helper tests and offline lifecycle checks against the installed Pi runtime.
Set `PI_BIN` if the executable is not available as `pi`.
