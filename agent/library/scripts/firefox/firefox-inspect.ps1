#requires -Version 5.1
<##
.SYNOPSIS
    Inspect visible Firefox accessibility elements by name.
#>

[CmdletBinding()]
param(
    [string]$WindowTitle,
    [string]$TabName,
    [string]$Pattern,
    [ValidateRange(0, 10000)]
    [int]$WaitMilliseconds = 400
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "FirefoxUi.psm1") -Force -DisableNameChecking

$firefox = Get-TargetFirefox -WindowTitle $WindowTitle
Focus-Firefox -Process $firefox -WaitMilliseconds $WaitMilliseconds
if ($TabName) {
    Select-BrowserTab `
        -Root (Get-AutomationRoot -Process $firefox) `
        -Name $TabName `
        -WaitMilliseconds $WaitMilliseconds | Out-Null
}

Inspect-UiElements `
    -Root (Get-AutomationRoot -Process $firefox) `
    -NamePattern $Pattern |
    Format-Table -AutoSize
