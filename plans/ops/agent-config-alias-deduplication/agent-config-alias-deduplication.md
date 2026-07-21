# Avoid duplicate agent configuration through path aliases

A global agent configuration can also appear under a workspace's project-config path when the workspace is a home directory, a bind mount, or another alias. If a runtime deduplicates local packages by resolved path string, the global and project paths may look different even though they reference the same files. Extensions can then load twice and collide on tool or command registration.

## Safe pattern

1. Put the guard in a global/user extension because project extensions are not available before trust is decided.
2. Handle the runtime's documented pre-trust event; do not guess the event name or result schema.
3. Compare filesystem identity for `<cwd>/<project-config-dir>` and the global config root. On POSIX systems, compare device and inode rather than pathname text.
4. Return an explicit untrusted decision only for the alias when the global copy must remain active and the project copy must remain disabled. Return undecided for every other project so normal trust policy still applies.
5. Fail open to normal trust behavior when either path cannot be inspected.
6. Check trust-override precedence. If CLI or SDK approval bypasses the event, prevent that launch mode externally or document it as unsupported for the alias workspace.
7. Verify warning behavior separately. A negative trust result may suppress the prompt but still produce an intentional post-resolution warning.

Prefer a supported runtime option or upstream alias-aware trust fix for suppressing a misleading alias warning. If neither exists and a presentation shim is justified:

- verify the exact installed renderer and lifecycle before patching;
- preserve and delegate to the original renderer for every non-alias case;
- make installation process-idempotent;
- fail open when the private method is absent or changes;
- keep the trust decision and resource-loading policy independent from the presentation patch;
- add an upgrade regression test and a documented rollback path.

An alternative is to canonicalize every global/project resource reference to one stable pathname and trust the alias, but this is safe only when auto-discovered resources are also deduplicated. Test extensions, skills, prompts, and themes—not just configured packages.

## Verification

- Start from the aliased workspace and assert there is no trust prompt or misleading warning.
- Assert the same startup has no duplicate registration or resource-collision diagnostics.
- Confirm project resources remain disabled when the alias decision is untrusted.
- Start from an unrelated trusted project and confirm its project resources still load.
- Start from an unrelated untrusted project and confirm the original warning still renders.
- Test missing/inaccessible paths to confirm the guard returns undecided.
- Exercise explicit approve/decline overrides and record whether they bypass the hook.
- Simulate a missing private renderer and confirm startup fails open without crashing.
