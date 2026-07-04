---
name: gnome-shell-extension-tiling-port
description: Reusable pattern for porting a TypeScript reference GNOME Shell extension's pure logic into a plain-JS sibling extension, plus a checklist for auditing/fixing GNOME Shell "current monitor" bugs.
metadata:
  type: plan
---

# Porting a reference GNOME Shell extension's logic into a sibling plain-JS extension

Applies when: you have an existing plain-JS, no-build-step GNOME Shell
extension (`<target-extension>`), and a separate, more advanced reference
extension (`<reference-extension>`) — often TypeScript, often compiled via
esbuild — that already solves a hard subproblem (e.g. a tiling window
manager engine, a config-file parser, a complex layout algorithm) that you
want folded into the target extension without adopting a build toolchain.

## Recognize the reusable shape

Before porting, check whether the reference extension is already split into:
- A **pure layer** with zero `gi://`/`resource:///` imports (no Mutter/Shell
  API calls) — e.g. a tree/engine module, a lexer/parser, pure geometry math.
- A **thin adapter layer** that is the *only* code touching the compositor
  (window adoption, signal wiring, accelerator grabbing).

This split (if present) is exactly what makes a mechanical, low-risk port
possible: the pure layer ports almost verbatim (strip TS types → JSDoc
typedefs), and only the adapter layer needs real redesign work to fit the
target extension's conventions (e.g. generalizing a single-monitor-only
adapter to true multi-monitor by removing a hardcoded
primary-monitor-only filter — check for this specific anti-pattern, it's
common in reference implementations built against one screen).

## Provenance check (do this before porting, not after)

If the reference extension has no LICENSE file / no license field in its
package manifest, treat the port as a **clean-room re-implementation**
guided by reading the algorithms — rename identifiers, restructure control
flow where natural for the target language/style — rather than a mechanical
find-replace transliteration. Verify upstream licensing (check the real
origin repo, not just a local snapshot) before any public release of the
result. If a genuinely licensed upstream/original project of the same
domain exists (e.g. the actual C/Rust/Go source the reference extension is
itself inspired by), cross-check behavior/semantics against that as an
authoritative source — it can also help resolve ambiguity the reference
extension's own tests don't cover.

## Settings/config model divergence

If the reference extension stores arbitrary/open-ended user config as raw
text and re-derives behavior from it live (common for "import a real config
file" features), and the target extension has its own finite,
prefs-editable settings schema, don't copy that live-re-derivation model
wholesale. Instead:
- Map recognized, fixed-cardinality config directives onto discrete,
  named settings keys in the target's own schema.
- Store variable-cardinality data (rules, per-mode bindings, etc.) as one
  JSON-serialized string setting rather than exploding the schema.
- Never silently drop unrecognized/unmapped directives — surface a count/
  summary in the preferences UI so users know what wasn't imported.
- Offer both a manual "import now"/"reload from file" action (button +
  optional keybinding) rather than continuous file-watching, unless live
  sync was explicitly requested — it's simpler to reason about and test.

## Module layout

Keep the ported pure logic in its own top-level directory (e.g. `tiling/`),
separate from the target extension's existing per-feature module
convention (e.g. `tricks/`), with the compositor-facing adapter living
alongside the existing per-feature modules. This keeps the purity boundary
visible in the directory structure itself, not just in code review.

---

# Checklist: auditing GNOME Shell "current monitor" bugs

A common bug class in GNOME Shell extensions that manipulate window
geometry: using `display.get_current_monitor()` (the monitor under the
mouse pointer / with input focus) as a stand-in for "the monitor the window
I'm operating on is actually on." This silently breaks on any multi-monitor
setup where the pointer isn't on the same monitor as the target window.

When auditing/fixing this://
1. Grep for `get_current_monitor()` across the codebase — every call site is
   a candidate bug.
2. Replace with an explicit monitor index/reference derived from the actual
   window in question (`window.get_monitor()`), threaded through function
   signatures rather than read implicitly inside a shared helper.
3. Check any manual panel-height/inset math applied uniformly to "the
   monitor" — GNOME's top bar typically only exists on the primary monitor,
   so subtracting its height from every monitor's work area is a second,
   related bug. Prefer `workspace.get_work_area_for_monitor(monitorIndex)`
   over manually computing insets — it already accounts for panel/dock
   reservations correctly per monitor.
4. For "find nearby/adjacent window" style directional searches: check
   whether a same-monitor search that comes up empty has any cross-monitor
   fallback at all. If not, and multi-monitor support is desired, add a
   geometric adjacent-monitor lookup (compare monitor rects the same way
   window rects are already compared for direction/distance) as a second
   pass — but only after the first pass, not as a blind full re-enumeration
   of all windows.
5. Watch for double-enumeration bugs hiding alongside the monitor bug: a
   "strict, then fallback" search pattern that re-fetches and re-filters an
   entire window list from scratch on fallback, rather than reusing/
   extending the first pass's data.

---

# Checklist: default keybindings must be checked against GNOME's own bindings

A GNOME Shell extension that ships default keybindings (especially anything
using bare `<Super>+key`, a modifier combo many extensions reach for since
it "feels free") can silently collide with GNOME Shell's and Mutter's own
stock keybindings. The collision doesn't error or warn — whichever binding
wins the grab just fires instead of the other, so an extension's hotkey can
appear to "just not work" (or trigger the wrong thing, e.g. opening Quick
Settings instead of the extension's own action) with no diagnostic at all.

Before finalizing (or adding to) a set of default keybindings:

1. Query the actual live defaults rather than trusting memory/docs, since
   these vary by GNOME version and can include non-obvious bindings:
   ```
   gsettings list-recursively org.gnome.shell.keybindings
   gsettings list-recursively org.gnome.desktop.wm.keybindings
   gsettings list-recursively org.gnome.mutter.keybindings
   gsettings list-recursively org.gnome.mutter.wayland.keybindings
   ```
2. Cross-reference every proposed default accelerator string against all
   four lists above, not just against the extension's own existing keys.
3. Known-common collisions worth checking specifically (observed live on a
   recent GNOME Shell): bare `<Super>` + `A`/`H`/`S`/`V`/`space`/any arrow
   key/`Page_Up`/`Page_Down` are frequently already bound (application view,
   minimize, quick settings, message tray, input-source switch, tile/
   maximize/unmaximize, workspace switch, respectively).
4. If a direction/arrow-key binding is wanted and bare `<Super>+arrow` is
   taken (it usually is, for tiled-left/right and maximize/unmaximize), add
   one extra modifier (e.g. `<Ctrl><Super>+arrow`) rather than fighting for
   the bare combo — cheap fix, and it doesn't collide with typical
   multi-modifier bindings extensions use elsewhere.
5. Verify empirically, not just by inspection: enable the extension in a
   live/nested session and press each default combo, watching for the
   *wrong* thing happening (e.g. a system menu opening) rather than assuming
   silence means success.
