#requires -Version 5.1
<##
.SYNOPSIS
    Invoke an accessible Firefox control or click a deliberate coordinate.
#>

[CmdletBinding()]
param(
    [ValidateSet("invoke", "expand", "collapse", "click")]
    [string]$Action,
    [string]$WindowTitle,
    [string]$TabName,
    [string]$ElementName,
    [ValidateSet("Any", "Button", "Hyperlink", "MenuItem", "TabItem", "ListItem", "Text", "Edit", "CheckBox")]
    [string]$ControlType = "Any",
    [int]$X = -1,
    [int]$Y = -1,
    [switch]$ScreenCoordinates,
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

if ($Action -eq "click") {
    Click-Point `
        -Process $firefox `
        -X $X `
        -Y $Y `
        -ScreenCoordinates:$ScreenCoordinates `
        -WaitMilliseconds $WaitMilliseconds
    exit 0
}

Invoke-UiAction `
    -Root (Get-AutomationRoot -Process $firefox) `
    -Name $ElementName `
    -ControlType $ControlType `
    -Action $Action `
    -WaitMilliseconds $WaitMilliseconds
