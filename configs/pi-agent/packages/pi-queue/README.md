# pi-queue

Manage messages typed while Pi is busy instead of immediately surrendering them to Pi's native steering/follow-up queues.

## Behavior

Plain interactive messages submitted whenever Pi is busy—including while it is compacting—are held as one managed message. Later submissions are appended on adjacent lines inside the same text string instead of creating additional queue entries. The first submission chooses the delivery mode:

- **Enter** → steer at the next turn boundary
- **Alt+Enter** → follow up after the current agent run

A pending-message card appears above Pi's working indicator. It shows the delivery mode and the complete queued text, wrapping long lines instead of truncating the message. Managed state is journaled into the current session, so `/reload`, resume, forks, and session switches restore the correct branch-local state instead of losing or carrying messages between sessions.

Registered extension commands execute before input interception. Other slash inputs are intentionally left to Pi's native path so skills and prompt templates still expand correctly; those inputs are not manageable through this extension.

## Controls

| Control | Action |
|---|---|
| `↑` while the editor is empty | Remove the managed text from the queue and restore it to the editor |
| `Alt+X` | Cancel the managed message |
| `Alt+Q` | Toggle the managed message between steer and follow-up |

## Delivery and limits

A steer message is transferred to Pi's native steering queue at `turn_end`. A follow-up is transferred at `agent_end`. Compaction-captured input is handed off when Pi flushes its compaction queue, including after success, cancellation, or failure; `agent_settled` provides a final recovery path for abnormal runs.

The single managed message is limited to 256 KiB of text. If full, new input is left to Pi's native queue rather than discarded. Attached images are preserved. When `↑` restores text from a message with images, the images remain managed rather than being silently discarded.

The widget wraps queued text within narrow-terminal width constraints.

## Verification

```bash
node --experimental-strip-types --test extensions/queue/logic.test.ts
```

Run the command from `configs/pi-agent/packages/pi-queue/`.
