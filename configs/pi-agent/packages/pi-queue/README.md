# pi-queue

Manage messages typed while Pi is busy instead of immediately surrendering them to Pi's native steering/follow-up queues.

## Behavior

Plain interactive messages submitted during an active run are held as separate, ordered entries. The first message chooses the queue-wide delivery mode:

- **Enter** → steer at the next turn boundary
- **Alt+Enter** → follow up after the current agent run

A compact pending-message card appears above Pi's working indicator while entries are pending. Its header shows the delivery mode and message count, followed by concise numbered previews and controls. Managed entries are journaled into the current session, so `/reload`, resume, forks, and session switches restore the correct branch-local state instead of losing or carrying messages between sessions.

Registered extension commands execute before input interception. Other slash inputs are intentionally left to Pi's native path so skills and prompt templates still expand correctly; those inputs are not manageable through this extension.

## Controls

| Control | Action |
|---|---|
| `Alt+X` | Cancel the newest managed entry |
| `Alt+Q` | Toggle all managed entries between steer and follow-up |
| `/queue` | Open the management panel |

The `/queue` panel supports:

| Key | Action |
|---|---|
| `↑` / `↓` | Select |
| `Enter` / `e` | Edit |
| `s` | Send now |
| `K` / `J` | Move up/down |
| `d` / `x` | Delete |
| `t` | Toggle delivery mode |
| `q` | Close (`Esc` remains a fallback) |

## Delivery and limits

Steer entries are transferred to Pi's native steering queue at `turn_end`. Remaining entries are transferred as follow-ups at `agent_end`; `agent_settled` provides a final recovery path for abnormal runs. Entries remain separate and ordered.

The managed queue is limited to 100 entries and 256 KiB of text. If full, new input is left to Pi's native queue rather than discarded. Attached images are preserved.

The widget and panel obey narrow-terminal width constraints, and the panel adjusts its visible list to terminal height.
