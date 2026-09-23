# Optional evaluation interchange format

Maintenance notice: substantially rewritten to replace the original schemas with
optional provider-neutral formats; see [license and attribution](../LICENSE.txt).

These JSON shapes are provider-neutral conveniences, not runtime requirements.
Use them only when machine-readable evaluation artifacts help. All paths are
workspace-relative strings, not relative to the containing result file. Validate
that each resolves inside the chosen evaluation workspace before access.

## `cases.json`

```json
{
  "schema_version": 1,
  "skill_name": "example-skill",
  "cases": [
    {
      "id": "normal-task",
      "prompt": "A realistic user request",
      "input_files": ["inputs/sample.txt"],
      "expected_outcome": "What a successful result accomplishes",
      "expectations": [
        "The output contains a valid JSON object",
        "No input file is modified"
      ],
      "review_questions": [
        "Is the result clear and useful for the intended reader?"
      ]
    }
  ]
}
```

Requirements:

- `schema_version`: integer, currently `1`.
- `skill_name`: declared skill name.
- `cases`: non-empty array.
- `id`: unique lowercase hyphen-case identifier.
- `prompt`: exact task prompt.
- `input_files`: optional array; empty when none.
- `expected_outcome`: human-readable success description.
- `expectations`: optional objective, verifiable statements.
- `review_questions`: optional qualitative questions.

Use the term `expectations` consistently. Do not mix it with `assertions` in the
same workflow.

## Per-run `result.json`

```json
{
  "schema_version": 1,
  "case_id": "normal-task",
  "configuration": "candidate",
  "status": "completed",
  "output_files": ["runs/normal-task/candidate/outputs/result.json"],
  "notes": [],
  "metrics": {
    "duration_seconds": 12.4
  }
}
```

`configuration` commonly identifies `candidate`, `original`, or `no-skill`.
`status` is `completed`, `failed`, `cancelled`, or `not-run`. Omit metrics the
runtime did not expose; never substitute zero for unknown telemetry.

## Per-run `grading.json`

```json
{
  "schema_version": 1,
  "case_id": "normal-task",
  "configuration": "candidate",
  "expectations": [
    {
      "text": "The output contains a valid JSON object",
      "status": "passed",
      "evidence": "Parsed runs/normal-task/candidate/outputs/result.json successfully",
      "method": "JSON parser"
    }
  ],
  "summary": {
    "passed": 1,
    "failed": 0,
    "not_assessable": 0
  }
}
```

Expectation `status` is `passed`, `failed`, or `not-assessable`. Evidence must
identify the observed basis; it must not rely solely on the executor's claim.

## Optional `comparison.json`

```json
{
  "schema_version": 1,
  "case_id": "normal-task",
  "variants": ["candidate", "original"],
  "preferred": "candidate",
  "confidence": "medium",
  "reasons": ["The candidate satisfied both objective expectations"],
  "limitations": ["Automatic trigger behavior was not tested"]
}
```

`preferred` may be either variant or `tie`. Keep variant identities hidden from a
blind reviewer until after judgment when the runtime supports that separation.

## Workspace layout

No layout is mandatory. One portable option is:

```text
evaluation-workspace/
├── cases.json
├── original-snapshot/       optional
└── runs/
    └── normal-task/
        ├── candidate/
        │   ├── result.json
        │   ├── grading.json
        │   └── outputs/
        │       └── result.json
        └── original/         optional comparison
```

Choose a user-approved writable location. Do not assume `/tmp`, a Downloads
folder, or a directory beside an installed read-only skill.
