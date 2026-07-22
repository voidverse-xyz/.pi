# Standalone CLI container cold-start pattern

Use this pattern when a Node-based extensible CLI has an officially supported
standalone executable and fresh containers spend most of startup loading the
runtime module graph.

## Approach

1. Measure fresh-process startup separately from container creation and terminal
   attachment.
2. Confirm the official standalone build supports dynamic extensions and ships
   every runtime sidecar.
3. Pin one release version and architecture-specific SHA-256 digests.
4. Select the release archive from `uname -m`, download only over HTTPS, and
   verify the digest before extraction.
5. Install the complete release bundle under a root-owned directory such as
   `/opt/<tool>` and expose only its executable through `/usr/local/bin`.
6. Set the tool's package/assets directory explicitly when symlink resolution
   could make runtime asset discovery ambiguous.
7. Retain Node and the package manager only when project tools or extension
   installation still require them.
8. Label the image with its tool version, runtime type, and known compatibility
   limitations.

## Safe release flow

- Build and smoke-test locally by default.
- Never make a build helper push implicitly.
- Make publish mode operate on an existing local image without rebuilding it.
- Re-run deterministic smoke checks immediately before the push.
- Emit a clear warning for known compatibility degradation and keep publishing explicit.
- Push the exact image ID that received manual interactive testing.

## Verification matrix

- Exact executable version matches the image label.
- Required themes, docs, export templates, native modules, and WASM assets exist.
- Both supported CPU architectures select a pinned digest.
- Extension loading works with the real configured extension set.
- Extensions use bundled package-root exports rather than private filesystem imports; version-pinned shims fail open.
- Child-process/self-spawn procedures resolve the standalone executable.
- Interactive startup, reload, session persistence, and terminal reconnect work.
- At least five fresh-container samples are compared by median and worst case.

A module compile cache can be a low-risk secondary optimization, but benchmark
it first. It is often UID-, runtime-, path-, and architecture-specific and may
save only a small fraction of a second compared with replacing the runtime
module graph with a supported standalone executable.
