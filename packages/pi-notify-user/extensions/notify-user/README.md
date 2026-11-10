# notify-user

Registers the LLM-callable `notify_user` tool with four focused capabilities:

- `successes`: completed or successful outcomes
- `warnings`: risks and caveats
- `errors`: failures and blockers
- `urgent`: immediately toast the highest-priority item

Non-empty notices render as color-banded transcript blocks after the agent fully
settles. Severity is inferred as errors, then warnings, then successes. There is no
generic information section, title, or explicit severity override.
