# Standalone extension compatibility

## Scope

Pi 0.80.10's standalone Bun executable loads extension dependencies through a
fixed virtual-module table. Package-root imports for Pi, Pi TUI, Pi AI, and
TypeBox work without an npm module tree. Arbitrary file-URL imports of private Pi
implementation files do not.

## Changes

Void Agent no longer derives private renderer module paths from the CLI entry
file. Its presentation shims now use class objects reachable from Pi's bundled
package-root export:

- The tool separator patches the root-exported `ToolExecutionComponent`.
- The working background intercepts the root-exported `InteractiveMode` host and
  decorates each working-indicator instance as Pi installs it.

This preserves the existing native status-container placement, tool rendering,
spacing, dividers, animated background, and Matrix layer in both npm and
standalone distributions. The private render shapes remain intentionally pinned
to Pi 0.80.10, fail open, warn when unavailable, and restore on shutdown. The
config-alias trust-warning shim now follows the same restoration lifecycle.

Child Pi launchers in the changes, commit, and merge packages now classify the
runtime from `process.execPath` before considering `process.argv[1]`. A compiled
executable therefore reinvokes itself directly regardless of Bun's virtual entry
path spelling; Node and Bun script runtimes continue to pass their real script
path.

## Verification

Run:

```bash
node configs/pi-agent/packages/void-agent/test/working-background.test.mjs
node configs/pi-agent/packages/void-agent/test/tool-separator.test.mjs
node configs/pi-agent/packages/void-agent/test/config-alias-guard.test.mjs
node configs/pi-agent/test/standalone-invocation.test.mjs
```

Then test the configured TUI with the official standalone Pi 0.80.10 release.
The static tests prove shared root-export class identity and restoration; only a
real standalone TUI run verifies bundled-runtime behavior end to end.
