# Same-turn run summary protocol

## Goal

Improve `pi-run-summary` outcome quality without launching another model request or persisting protocol text in the conversation.

## Design

1. In TUI mode, `before_agent_start` appends a stable instruction asking the active model to place one concise factual outcome in a terminal Markdown reference definition:

   ```markdown
   [pi-run-summary]: # "SUMMARY"
   ```

   Pi's Markdown renderer recognizes a completed reference definition as metadata and does not display it. An incomplete prefix may appear briefly while tokens are still streaming; `message_end` cannot retroactively hide streamed content.

2. `message_end` inspects only finalized assistant messages. It captures a terminal marker from the last text part, removes the marker through Pi's supported message-replacement result, and keeps the extracted outcome in the current in-memory run state. Ordinary trailing LF/CRLF is accepted; a malformed reserved terminal marker is scrubbed without becoming an outcome.
3. Tool-call turns have markers stripped if present but cannot replace either the generated outcome or deterministic fallback prose.
4. The latest non-tool final response owns the outcome. If it has no valid marker, the extension clears any stale generated value and falls back to the first meaningful sentence.
5. `agent_settled` emits the notice only after Pi is truly idle. Session shutdown discards pending state.

## Cost and privacy

This adds no provider round trip. The stable instruction and short generated sentence add a small number of tokens to the existing turn. The marker is removed before the finalized assistant message is stored, so it does not consume future conversation context. Non-TUI modes receive neither the instruction nor the notice.

## Failure behavior

- Missing, empty, malformed, or nonterminal markers use deterministic extraction; reserved malformed terminal lines are removed before persistence.
- Fallback summaries are not hard-truncated; Pi wraps the notification at terminal width.
- Abort, error, and length stops retain their existing stop-reason fallback when no prose is available.
- A later continuation cannot reuse a stale generated outcome from an earlier final response.

## Verification

- Assert the prompt instruction is TUI-only and preserves the chained system prompt.
- Assert a terminal marker with LF or CRLF is extracted and removed from the finalized response.
- Assert a malformed reserved terminal marker is scrubbed and a nonterminal marker is ignored.
- Assert Pi hides a completed, blank-line-separated definition.
- Assert the model-authored outcome reaches the completion notice.
- Assert an absent marker uses an untruncated deterministic fallback.
- Retain lifecycle, idle gating, token accounting, non-TUI, and shutdown tests.
