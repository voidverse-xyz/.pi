# Delegated review results

Use this procedure whenever Pi Subagents review findings are required in the current response.

1. Prefer one narrowly scoped reviewer. Add reviewers only for independent purviews.
2. Put the full brief and concise result contract in the initial task. Request verdict, prioritized findings with evidence, fixes, and verification; forbid raw file dumps.
3. Capture `taskEnvelopeId` from `subagent_spawn` or `envelopeId` from `subagent_send`.
4. Await the assignment with `subagent_await` using `targets: [{ to: "<address>", anchorId: "<captured-id>" }]`. Use `mode: "all"` unless intentionally waiting for the first of several independent tasks.
5. Inspect every result. A `completed` outcome contains the final report. An `error` or `retired` outcome means the review did not complete successfully. A top-level `timeout` leaves listed targets pending; do not substitute status or cleanup details for findings.
6. A question or escalation is returned as a completed final waiting/blocked report, so its old anchor is consumed. Answer with a new `subagent_send`, capture the new envelope ID, and await that new anchor. Never re-await a consumed anchor.
7. On cancellation, state that independent review was not completed.
8. Let a one-shot reviewer auto-retire after its final report. Do not send a redundant finalize message or retire it before delivery.
9. Present results in this order: verdict, findings, fixes or decision, verification, then one short operational caveat when needed.

A delegated review is complete only when the exact assignment returns a `completed` outcome containing its final report. Pi Subagents does not use final/collect await modes or a separate collection call.
