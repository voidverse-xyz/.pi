#requires -Version 5.1
<##
.SYNOPSIS
    List or select visible Firefox browser tabs.
#>

[CmdletBinding()]
param(
    [ValidateSet("list", "focus", "select")]
    [string]$Action = "list",
    [string]$WindowTitle,
    [string]$TabName,
    [ValidateRange(0, 10000)]
    [int]$WaitMilliseconds = 400
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "FirefoxUi.psm1") -Force -DisableNameChecking

$firefox = Get-TargetFirefox -WindowTitle $WindowTitle
if ($Action -eq "list") {
    $tabs = @(Get-BrowserTabElements -Root (Get-AutomationRoot -Process $firefox))
    for ($index = 0; $index -lt $tabs.Count; $index++) {
        $marker = if (Test-Selected -Element $tabs[$index]) { "*" } else { " " }
        "[{0}] {1} {2}" -f ($index + 1), $marker, $tabs[$index].Current.Name
    }
    exit 0
}

if (-not $TabName) {
    throw "-TabName is required for -Action $Action."
}

Focus-Firefox -Process $firefox -WaitMilliseconds $WaitMilliseconds
$selected = Select-BrowserTab `
    -Root (Get-AutomationRoot -Process $firefox) `
    -Name $TabName `
    -WaitMilliseconds $WaitMilliseconds
"Selected browser tab: $selected"
