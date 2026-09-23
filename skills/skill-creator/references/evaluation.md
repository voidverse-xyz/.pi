# Portable skill evaluation

Use this workflow only when evaluation is justified by the skill's risk, scope, or
user request. It does not depend on subagents, a browser, telemetry, or one model
provider.

## 1. Define cases before running them

Choose realistic tasks from the intended domain. Include normal use, an important
edge case, a constrained environment, and near-miss trigger cases. Avoid toy
prompts that any general agent can solve without the skill.

For each task record:

- stable case ID and descriptive name,
- prompt and required input files,
- expected outcome,
- objective expectations when available,
- qualitative review questions,
- safety or side-effect constraints.

Use the [optional JSON schemas](schemas.md) when machine-readable interchange
helps. Plain Markdown is fine for a small manual evaluation.

## 2. Choose the comparison

- New skill: candidate versus no-skill baseline when the runtime can suppress it.
- Revised skill: candidate versus a preserved original snapshot.
- Runtime migration: same skill intent through old and new runtime adapters.
- Trigger evaluation: metadata candidate versus current metadata on the same
  positive and near-miss prompts.

Keep task inputs, runtime, model/settings, permissions, and available tools as
equivalent as practical. Record unavoidable differences.

## 3. Run with available capabilities

Prefer isolated runs. Parallel execution is optional; serial execution is valid
and often easier to reproduce. If independent workers are unavailable, execute
cases manually and disclose that the author and evaluator shared context.

Store results in a user-approved workspace. Do not assume a sibling directory,
system temporary location, or download folder. Use stable descriptive directory
names rather than relying on sequence numbers alone.

Capture only metrics the runtime actually exposes. Wall-clock timing can be
measured externally when useful, but token counts, internal steps, or transcripts
must not be invented.

## 4. Grade appropriately

Use deterministic inspection for machine-checkable outcomes such as file format,
JSON shape, required fields, test results, or forbidden content. Use human or
blind review for clarity, design, usefulness, and other judgment-heavy qualities.

An expectation should distinguish a good result from a plausible failure. Record:

- expectation text,
- pass/fail or not-assessable status,
- concise evidence,
- inspection method.

Do not convert every subjective preference into a binary metric.

## 5. Analyze

Look beyond aggregate pass rate:

- expectations that always pass in both variants,
- regressions hidden by an improved average,
- flaky or environment-sensitive cases,
- additional cost or latency,
- instructions ignored by every run,
- failures caused by unavailable runtime capabilities,
- test leakage or overfitting.

Prefer a candidate only when the evidence supports the intended tradeoff. A tie
may justify keeping the smaller or simpler skill.

## 6. Review with the user

Present outputs through whatever the environment supports: chat, a native file
viewer, generated static report, or ordinary files. A browser UI is optional.
Show the task, candidate result, baseline when applicable, checks, and known
limitations. Incorporate feedback without overfitting to a single example.

## 7. Iterate and stop

Revise the smallest causal part of the skill, rerun affected cases plus a small
regression set, and stop when:

- agreed acceptance criteria pass,
- remaining differences are subjective or immaterial,
- further complexity costs more than it helps,
- the user accepts the result.

Retain evaluation artifacts only when they have ongoing value and do not contain
sensitive inputs, transcripts, or credentials.
