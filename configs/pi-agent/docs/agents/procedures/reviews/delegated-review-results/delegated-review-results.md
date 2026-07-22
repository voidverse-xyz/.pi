# Delegated review results

Use this procedure whenever a reviewer/scout's findings are expected in the current user response.

1. Prefer one narrowly scoped reviewer. Add reviewers only for independent purviews.
2. Put the full brief and a concise report contract in the initial task. Request verdict, prioritized findings with file/line evidence, fixes, and verification; forbid raw file dumps.
3. Use a unique oneshot for a single review assignment.
4. Capture `taskEnvelopeId` from `subagent_spawn` (or `envelopeId` from `subagent_send`).
5. Call `subagent_await` with `waitFor:"final"` and that anchor. For structured collection, use `waitFor:"collect"` with the `subagent_collect` request ID.
6. On `attention`, answer the question or handle/deny the escalation, then await again with the same anchor.
7. On `timeout`, say the review remains pending. Do not claim completion or substitute status/cleanup logs for findings.
8. On cancellation, state that independent review was not completed.
9. Let a oneshot auto-retire after its final report. Do not interrupt, send a second “finalize” message, and immediately retire it.
10. Present results in this order: verdict, findings, fixes/decision, verification, then one short operational caveat if needed.

A delegated review is complete only after `subagent_await` returns `status:"completed"` or the final report was already delivered directly into the current context.
