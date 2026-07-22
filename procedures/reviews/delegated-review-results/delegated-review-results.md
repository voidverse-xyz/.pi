# Delegated review results

Use this procedure whenever delegated review findings are expected in the current response.

1. Prefer one narrowly scoped reviewer. Add reviewers only for independent purviews.
2. Put the full brief and a concise report contract in the initial task. Request verdict, prioritized findings with evidence, fixes, and verification; forbid raw file dumps.
3. Capture a durable task/request anchor from the dispatch or collection call.
4. Await or join the exact anchor before reporting completion. Use the host's final-result mode for one task, or collect-result mode for structured fan-in.
5. On worker attention, question, escalation, or error, resolve it and then await the same anchor again.
6. On timeout, say the review remains pending. Do not substitute status, cleanup logs, or partial orchestration details for findings.
7. On cancellation, state that independent review was not completed.
8. Let one-shot workers finish their final-report lifecycle normally; do not send redundant finalize messages or immediately retire a worker before its report is delivered.
9. Present results in this order: verdict, findings, fixes or decision, verification, then one short operational caveat if needed.

A delegated review is complete only after the anchored final or collect report is available in the current context.
