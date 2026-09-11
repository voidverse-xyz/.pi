#requires -Version 5.1
<##
.SYNOPSIS
    Compatibility entry point for the focused Firefox helper scripts.

.DESCRIPTION
    Prefer firefox-tabs.ps1, firefox-inspect.ps1, firefox-action.ps1 and
    firefox-capture.ps1. This wrapper keeps the earlier single-command interface
    available for agents that already use it.
#>

[CmdletBinding()]
param(
    [ValidateSet("list-windows", "list-tabs", "focus", "inspect", "invoke", "expand", "collapse", "select", "click", "capture")]
    [string]$Command = "list-tabs",
    [string]$WindowTitle,
    [string]$TabName,
    [string]$ElementName,
    [string]$Pattern,
    [ValidateSet("Any", "Button", "Hyperlink", "MenuItem", "TabItem", "ListItem", "Text", "Edit", "CheckBox")]
    [string]$ControlType = "Any",
    [string]$Path,
    [ValidateRange(0, 2000)]
    [int]$CropTop = 0,
    [ValidateRange(0, 10000)]
    [int]$WaitMilliseconds = 400,
    [int]$X = -1,
    [int]$Y = -1,
    [switch]$ScreenCoordinates,
    [switch]$IncludeChrome
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path

function Add-OptionalParameter {
    param([hashtable]$Parameters, [string]$Name, $Value, [bool]$Include)
    if ($Include) {
        $Parameters[$Name] = $Value
    }
}

switch ($Command) {
    "list-windows" {
        Import-Module (Join-Path $scriptDirectory "FirefoxUi.psm1") -Force -DisableNameChecking
        Get-FirefoxWindows -WindowTitle $WindowTitle |
            Select-Object Id, MainWindowTitle, MainWindowHandle
    }
    "list-tabs" {
        & (Join-Path $scriptDirectory "firefox-tabs.ps1") -Action list -WindowTitle $WindowTitle -WaitMilliseconds $WaitMilliseconds
    }
    "focus" {
        & (Join-Path $scriptDirectory "firefox-tabs.ps1") -Action focus -WindowTitle $WindowTitle -TabName $TabName -WaitMilliseconds $WaitMilliseconds
    }
    "select" {
        & (Join-Path $scriptDirectory "firefox-tabs.ps1") -Action select -WindowTitle $WindowTitle -TabName $TabName -WaitMilliseconds $WaitMilliseconds
    }
    "inspect" {
        & (Join-Path $scriptDirectory "firefox-inspect.ps1") -WindowTitle $WindowTitle -TabName $TabName -Pattern $Pattern -WaitMilliseconds $WaitMilliseconds
    }
    "capture" {
        $parameters = @{
            WindowTitle = $WindowTitle
            TabName = $TabName
            Path = $Path
            CropTop = $CropTop
            WaitMilliseconds = $WaitMilliseconds
        }
        if ($IncludeChrome) { $parameters.IncludeChrome = $true }
        & (Join-Path $scriptDirectory "firefox-capture.ps1") @parameters
    }
    default {
        $parameters = @{
            Action = $Command
            WindowTitle = $WindowTitle
            TabName = $TabName
            ElementName = $ElementName
            ControlType = $ControlType
            WaitMilliseconds = $WaitMilliseconds
            X = $X
            Y = $Y
        }
        if ($ScreenCoordinates) { $parameters.ScreenCoordinates = $true }
        & (Join-Path $scriptDirectory "firefox-action.ps1") @parameters
    }
}
