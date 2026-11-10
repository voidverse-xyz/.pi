# pi-teams

Persistent team agents with optional peer messaging, disk-backed mail, anchored
`team_await`, and a `/teams` roster and transcript viewer.

## Worker context selection

Main selects `contextMode: "auto" | "focus" | "fork"` when spawning a worker. Auto
is the default: prefer copied main chat strictly below 30% context usage, otherwise
prefer focused role/task context. Unknown usage defaults to focus. Explicit focus
or fork overrides the preference at any percentage.

Fork copies one snapshot of the active, compaction-aware conversation after context
edits, then appends the new assignment. No model call prepares a summary. The worker
keeps its own system instructions, identity, tools and permissions. Completed calls
are historical, unfinished calls are excluded, and old approval text grants no consent.
Explicit fork requires readable canonical main history.

Only new workers are seeded. Reusing an address preserves existing memory regardless
of a later contextMode; use a new ID for a new fork. Taskless forks save their history
before receiving work and survive reload. Spawn returns contextMode as fork, focus or
existing. Copied parent usage is excluded from worker token/cost/turn totals while
native context estimates remain intact. Token/cache savings have not been measured.

The helper is bundled under this package's `extensions/teams/context/` directory.
This package has no runtime dependency on either other extension or the parent repository.
The repository maintains identical copies from a canonical source; installing this
package alone includes everything needed for context selection.

## Agent lifetime

All Teams agents are persistent. `team_spawn` gets or creates `<type>/<id>`,
with `id` defaulting to `main`; use separate IDs for separate instances of a type.
There is no lifetime option. A final report completes the assignment and leaves
the agent dormant, ready for follow-up mail. Use `team_retire` (or the roster's
retire action) when an agent is no longer needed; its memory is archived.

Existing registry entries retain their addresses, sessions, and mail across
reload, including agents created with the former one-shot option. Their obsolete
lifetime field is removed on load, and they now persist until explicitly retired.
Already archived agents remain archived. Pi Subagents' lifetimes are independent.

## Delivery and completion

Tool results use compact JSON. Successfully delivered final reports, `ask`, and
`send_message { expectReply: true }` terminate the automatic follow-up only when
all finalized results in the tool batch terminate. Progress reports, ordinary
messages, answers, and delivery failures never terminate. Questions resume with
their correlated answers. Final reports complete assignments while keeping agents
available for follow-up work with their memory intact; only explicit retirement
removes an agent.

Idle completions coalesce for 300 ms from the first event without extending the
deadline for later arrivals. Input, a new run, or shutdown cancels the timer.
Mail is consumed only when its envelope IDs are found in the persisted host
transcript—not when Pi's void `sendMessage` returns. Failed or interrupted
injections stay pending for the next lifecycle/mail event or session resume.
An inference failure after persistence does not cause duplicate injection.

## Verification

Run the strict typecheck and all scripted-provider harnesses:

```bash
./test/e2e/run.sh
```

Reload or restart Pi after package changes.

## Keyboard agent navigation

With `pi-status-line` loaded, **Alt+N** cycles through subagents and team agents,
then back to the main chat. **Escape** also returns to main. The footer shows the
available count; the focused full-screen view shows the selected agent and its
position. **PageUp/PageDown** scroll its transcript. Live main-agent work continues
in the background. Opening a native dialog returns focus to main.

The themed heading sits above a padded **History** frame with space between
messages. A separate **Message agent** composer stays below history. Small
terminals use a compact layout, retaining the active cursor when drafts resize.

The focused editor sends text mail only to the selected agent: dormant persistent
agents wake and busy agents queue it. Unavailable recipients report a delivery
failure. Drafts
are retained while cycling, and failed mail is retained for retry when reopening
the agent. Images are unsupported and are explicitly rejected. Paste text using
your terminal's text-paste command. Commands beginning with `/` or `!` return to
the main editor as a draft; press Enter there to execute them normally.

Packages communicate through plain-data events and remain independently loadable.
Without `pi-status-line`, the existing roster command and viewer remain available.
Session changes, reload, and shutdown release navigation listeners and views.
