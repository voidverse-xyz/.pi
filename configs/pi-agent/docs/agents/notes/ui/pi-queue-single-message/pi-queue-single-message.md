# Pi Queue Single-Message Behavior

## Contract

`pi-queue` owns plain interactive input whenever Pi is busy, not only while the
model is streaming. Pi's TUI bypasses extension input hooks during compaction and
writes directly to a private native queue. The extension therefore installs a
narrow, reversible bridge around `InteractiveMode.queueCompactionMessage` and
`InteractiveMode.flushCompactionQueue`. If a future Pi version removes either
method, input falls back to Pi's native queue and the TUI shows a compatibility
warning rather than dropping the message.

The extension keeps one logical managed message containing one text string. Each
later submission is appended with a single newline, and attached images are
accumulated separately. The first submission continues to select steer or
follow-up delivery. Input captured during
compaction is handed off when Pi runs its native flush path after `compaction_end`.
That path runs for success, cancellation, and failure, so manual compaction cannot
strand a managed message.

The pending card renders the complete managed text with ANSI-aware wrapping. It
does not shorten the message to a one-line preview.

## Editor retrieval

When the main editor is empty, plain Up restores managed text to the editor and
removes it from the queue. All other Up presses delegate to the existing editor,
so normal multiline/history navigation is preserved.

The queue editor wrapper is installed during `resources_discover`, after all
`session_start` handlers. This composes with the final configured editor,
including Void Agent, instead of replacing its rendering and key handling. Its
cleanup restores the previous factory only when the queue wrapper is still the
active owner; Pi's `/reload` reset therefore cannot be overwritten by stale
shutdown cleanup.

Pi does not expose an extension API for restoring queued image attachments into
the editor. If a managed item includes both text and images, Up restores the text
and leaves an image-only managed item. An image-only item remains pending for
normal delivery and can still be cancelled with Alt+X; images are never silently
discarded.

The `/queue` command, management panel, and widget hint were removed after the
user explicitly confirmed removal. The card itself and its direct keyboard
controls remain.

## Verification

Run:

```bash
node --experimental-strip-types --test \
  configs/pi-agent/packages/pi-queue/extensions/queue/logic.test.ts
```

Coverage includes busy-input classification, the private compaction-queue bridge
and native fallback, success/failure flush behavior, ownership-safe editor cleanup,
single-message line coalescing, image accumulation, and safe editor restoration. Local TUI smoke verification also covers two submissions during
delayed synthetic compaction, full narrow-width wrapping, successful and cancelled
compaction handoff, `/reload`, and plain-Up restoration without a network
summarization call.
