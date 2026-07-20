# pi-model-thinking

Publishes Pi's current model and thinking level through the reserved
`model-thinking` extension-status key.

`pi-status-line` consumes that value, colors the thinking level with the active
Pi theme, and positions it on the right side of the shared row above the editor.
The status refreshes on session start and whenever the model or thinking level
changes.

Enable both `pi-model-thinking` and `pi-status-line`, then reload Pi with
`/reload`.
