# Generate a completion summary in the existing model turn

Use this pattern when a lifecycle integration needs a semantic completion summary but an additional model request would add unacceptable latency, cost, or failure modes.

## Pattern

1. Add a stable, minimal system instruction before the agent run. Request one concise factual outcome in a uniquely named terminal marker.
2. Ask for the marker only on the final non-tool response.
3. At the runtime's supported finalized-message hook, parse only a marker anchored to the end of the last text block.
4. Capture the outcome in ephemeral run state and replace the finalized message with a marker-free copy before persistence. If the renderer can show incomplete protocol prefixes during streaming, document that limitation or use a truly out-of-band channel.
5. Do not let tool-call turns set the final outcome.
6. Clear a previous outcome when a later final response omits or invalidates the marker.
7. At the truly-idle lifecycle boundary, render the outcome and discard run state.
8. Keep a deterministic fallback for noncompliance, aborts, errors, length limits, and runtimes without message replacement.

## Constraints

- Enable the instruction only in modes that consume the summary.
- Do not hard-truncate valid summaries when the renderer can wrap safely.
- Preserve usage metadata and all non-text content when replacing a message.
- Never launch a tool-enabled subagent for a one-sentence compression task.
- Treat the marker as protocol data: remove it before persistence so it does not consume later context.
- Keep the prompt static to preserve provider prefix-cache stability.

## Verification

Test prompt chaining, LF/CRLF marker extraction, malformed-marker scrubbing, finalized-message replacement, renderer behavior, multi-part assistant content, terminating-tool handling, stale-state clearing, deterministic fallback, idle/retry behavior, noninteractive modes, shutdown cancellation, and token accounting.
