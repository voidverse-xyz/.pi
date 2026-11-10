# pi-run-guard

Protects an active agent run from accidental interruption.

While Pi is working, it confirms before:

- starting or switching sessions
- cloning or forking
- navigating the session tree

Choices are to stop the run, stop and suppress further prompts until reload/restart,
or cancel the action. When Pi is idle, actions proceed without a prompt.

The guard fails closed in non-interactive modes: an active run is never interrupted
silently when confirmation UI is unavailable. The suppression flag is not persisted
and resets on `/reload` or process restart.
