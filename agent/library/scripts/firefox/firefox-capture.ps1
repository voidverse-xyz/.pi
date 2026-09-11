#requires -Version 5.1
<##
.SYNOPSIS
    Capture a visible Firefox window or client area.
#>

[CmdletBinding()]
param(
    [string]$WindowTitle,
    [string]$TabName,
    [string]$Path,
    [switch]$IncludeChrome,
    [ValidateRange(0, 2000)]
    [int]$CropTop = 0,
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

Capture-Firefox `
    -Process $firefox `
    -Destination $Path `
    -IncludeChrome:$IncludeChrome `
    -CropTop $CropTop
