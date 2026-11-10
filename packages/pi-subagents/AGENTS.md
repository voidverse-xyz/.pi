# pi-subagents development instructions

## Keep this an independent, portable Pi extension

This package must install, load and run by itself on a supported Pi installation.
Do not require either of the other coordination extensions, the parent configuration
repository, its shared-resource submodule, or a particular host directory at runtime.
Relative runtime imports must stay inside this package. Use public Pi SDK APIs and
declared package dependencies. Optional integrations must remain optional when absent.
Resolve resources through the package location or Pi's configured agent/project paths;
never assume the user installed the full configuration repository at a fixed location.

The context-fork helper in `extensions/subagents/context/fork.mjs` and its type declaration
belong to this package alone. Change them here without copying from, or synchronizing
with, another extension; the other coordination packages keep their own versions.
Its unit tests are in `test/fork-context.test.mjs`.

Before publishing changes, run the relevant package checks and the standalone portability
tests in `tests/portable-extensions.test.mjs` from the full repository. Those
tests copy one package at a time, check import boundaries, load it with Pi's own loader,
and exercise a native forked worker. Preserve the package's manifest, supported runtime
contracts and independent resource discovery. Portability does not justify claiming
support for an operating system or runtime version that has not been verified.
