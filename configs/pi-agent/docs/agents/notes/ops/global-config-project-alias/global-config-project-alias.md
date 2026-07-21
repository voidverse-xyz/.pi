# Global config/project alias fix

## Symptom

Starting Pi with the home directory as the workspace loaded every local package twice. Pi resolved global package paths through the container home and project package paths through the mirrored host workspace, so pathname-based package identity treated the same bind-mounted files as different packages. Tool registrations then conflicted and extension startup stopped.

## Root cause

Returning `{ trusted: "no" }` stopped duplicate package loading, but Pi `0.80.10` deliberately renders the warning whenever a workspace has trust-requiring resources and the resolved project decision is untrusted. A negative `project_trust` result suppresses the trust prompt, not the later warning. Returning `{ trusted: "yes" }` by itself suppresses the warning but reproduces the duplicate-tool failures because the global and project settings resolve the same packages through different pathname strings.

## Fix

The global `void-agent` extension handles Pi's pre-trust `project_trust` event. When `<cwd>/.pi` and the parent of Pi's effective agent directory are the same filesystem entry (`st_dev` + `st_ino`), it returns `{ trusted: "no" }`. This keeps the aliased project package set disabled, while other projects remain undecided and continue through Pi's normal saved/default trust flow.

Explicit `--approve`/`-a` is unsupported from the aliased home workspace. Pi applies that override before extension trust resolution, so the event cannot reject project loading and duplicate registrations can return. Saved `/trust` decisions and `defaultProjectTrust` do not have this precedence and remain overridden by the guard.

Pi 0.80.10 exposes no supported setting or extension result for suppressing one post-resolution warning. The extension therefore applies an idempotent presentation patch to `InteractiveMode.renderProjectTrustWarningIfNeeded`. The wrapper skips rendering only when the active workspace matches the same filesystem-identity test and delegates every other case to Pi's original renderer. The shim is pinned to the verified Pi version; a version mismatch or missing private method fails open and leaves the warning visible.

## Verification

- Pi `0.80.10` starts from the home workspace without the untrusted-project warning.
- The same startup has no duplicate-tool or skill-collision errors and loads each extension once.
- The alias still resolves to `{ trusted: "no" }`; project resources remain disabled.
- An unrelated project remains undecided and still reaches Pi's original warning renderer.
- Missing or inaccessible alias paths fail open to Pi's normal trust flow.
