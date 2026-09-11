# Firefox Automation

## Summary

Shared Windows Firefox helpers for listing tabs, inspecting controls, deliberate UI actions,
and screenshots. Requires Windows, PowerShell 5.1 or later, and an existing visible Firefox
window in an interactive desktop session. Firefox-specific selectors do not support arbitrary
browsers. Scripts accept window titles, tab names, selectors, and output paths as parameters.

## Details

The scripts live under `~/.pi/agent/library/scripts/firefox/` and resolve their shared module relative to
the script location, independently of the current project. Script contents were preserved during
relocation; live UI behavior has not been reverified.

## Focused Firefox helpers

The focused scripts share their implementation through `FirefoxUi.psm1`:

| Script | Use it for |
| --- | --- |
| [Tabs](../scripts/firefox/firefox-tabs.ps1) | List browser tabs or select/focus one by title. |
| [Inspect](../scripts/firefox/firefox-inspect.ps1) | List visible accessibility elements, optionally filtered by a regular expression. |
| [Actions](../scripts/firefox/firefox-action.ps1) | Invoke, expand or collapse an accessible control, or click an explicit coordinate. |
| [Capture](../scripts/firefox/firefox-capture.ps1) | Capture the visible Firefox window/client area to a PNG. |
| [Shared module](../scripts/firefox/FirefoxUi.psm1) | Shared functions; import this only when composing another helper. |
| [Compatibility entry point](../scripts/firefox/firefox-ui.ps1) | Compatibility wrapper for the earlier single-command interface. Prefer the focused scripts above. |

Run from any directory using the shared location:

```powershell
$helpers = Join-Path $HOME '.pi/agent/library/scripts/firefox'

# List browser tabs, then select a tab by a distinctive title.
pwsh -File "$helpers/firefox-tabs.ps1" -Action list
pwsh -File "$helpers/firefox-tabs.ps1" -Action focus -TabName 'Example'

# Find controls whose accessible names mention security or settings.
pwsh -File "$helpers/firefox-inspect.ps1" -Pattern 'security|mfa|users|settings'

# Invoke or expand an accessible control. Narrow duplicate names with -ControlType.
pwsh -File "$helpers/firefox-action.ps1" -Action invoke `
  -ElementName 'Settings' -ControlType MenuItem
pwsh -File "$helpers/firefox-action.ps1" -Action expand `
  -ElementName 'Settings' -ControlType MenuItem

# Capture the Firefox client area without the outer window frame.
pwsh -File "$helpers/firefox-capture.ps1" `
  -Path "$env:TEMP\browser-review.png"

# Crop a known number of client-area pixels from the top when the tabs and
# address bar should not be retained. Check the result before using it.
pwsh -File "$helpers/firefox-capture.ps1" `
  -Path "$env:TEMP\browser-content.png" -CropTop 112

# Use client-area coordinates for a deliberate click after inspecting a current screenshot.
pwsh -File "$helpers/firefox-action.ps1" -Action click -X 140 -Y 600
```

Use `-WindowTitle` when more than one Firefox window is visible. Use
`-IncludeChrome` only when retaining browser tabs and the address bar is safe;
URLs can contain session material. Coordinate clicks are intentionally explicit
and should be used only after inspecting a current screenshot. The helper does
not provide a `-WhatIf` dry run for clicks; use the inspect and capture commands
first.

The helper does not enter credentials or one-time codes. Agents must not pass
secrets as parameters, and must inspect screenshots and command output for email
addresses, tokens, recovery codes, private URLs or other sensitive content
before retaining or sharing them. Screenshots belong in the temporary directory
or another explicitly approved location, not in the shared library or project `.agents/`.

If the UI changes, prefer adding a narrow selector or parameter to the helper
rather than repeating a long inline PowerShell script in a task transcript.
