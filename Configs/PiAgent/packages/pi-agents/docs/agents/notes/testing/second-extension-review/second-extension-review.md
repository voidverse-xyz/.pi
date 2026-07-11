# Second Extension Review

Date: 2026-07-11

A second focused review covered runtime lifecycle/concurrency, mail and persisted state, schema/frontmatter parsing, sandbox classification, host trust integration, and unused TypeScript symbols.

## Findings fixed

- Persistent get-or-create could attach to an active oneshot with the same generated address.
- Different runtimes in one process treated the same PID as shared run ownership.
- The collect validator ignored malformed values for supported schema keywords and used prototype-chain membership for JSON properties.
- Restricted frontmatter parsing accepted or misdecoded quoted scalar forms.
- Attached/bundled in-place flags for `sed` and `perl` bypassed path policy.
- `git remote -v add ...` was incorrectly classified as read-only.
- Project-local typedef trust failed open when the host trust check was absent or threw.
- Initial settings loading did not seed live reload's last-known-good fallback.
- Two unused bindings remained; strict test configuration did not detect unused locals/parameters.

## Regression coverage

Added cases for lifetime mismatch, same-PID runtime ownership, malformed schemas, inherited property names, quoted scalar escaping, in-place command variants, verbose mutating git-remote commands, first-reload settings failure, and unused TypeScript checks.

Validation command:

```sh
bash test/e2e/run.sh
```
