# Delegated review results

Reusable protocol for agent systems with asynchronous workers and an anchored await/join tool.

1. Assign one bounded reviewer per independent purview.
2. Include the full brief and a concise verdict/findings/evidence/fixes report contract.
3. Capture the task or collect request ID as the result anchor.
4. Await the anchored final/correlated report before reporting completion.
5. Return early for worker questions, escalations, or errors; handle them and await again.
6. Timeout consumes nothing and means “still pending,” not “complete.”
7. Cancellation means independent review is incomplete.
8. Let final-report lifecycle cleanup run normally; do not interrupt/finalize/retire in rapid succession.
9. Present verdict and findings before orchestration or cleanup details.

This closes the common failure mode where an orchestrator answers first and receives the actual review only on a later turn.
