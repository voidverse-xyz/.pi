# Shared implementation for the focused Firefox helper scripts.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

if (-not ("AgentFirefoxUi.NativeMethods" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;

namespace AgentFirefoxUi {
    public static class NativeMethods {
        [StructLayout(LayoutKind.Sequential)]
        public struct Rect {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct Point {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr handle, out Rect rect);

        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr handle, out Rect rect);

        [DllImport("user32.dll")]
        public static extern bool ClientToScreen(IntPtr handle, ref Point point);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr handle);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr handle, int command);

        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll")]
        public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

        public const int ShowNormal = 9;
        public const uint LeftDown = 0x0002;
        public const uint LeftUp = 0x0004;
    }
}
"@
}

function Get-FirefoxWindows {
    [CmdletBinding()]
    param([string]$WindowTitle)

    $windows = @(Get-Process -Name firefox -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowHandle -ne [IntPtr]::Zero
    })

    if ($WindowTitle) {
        $windows = @($windows | Where-Object {
            $_.MainWindowTitle -like "*$WindowTitle*"
        })
    }

    return $windows
}

function Get-TargetFirefox {
    [CmdletBinding()]
    param([string]$WindowTitle)

    $windows = @(Get-FirefoxWindows -WindowTitle $WindowTitle)
    if ($windows.Count -eq 0) {
        $suffix = if ($WindowTitle) { " matching '$WindowTitle'" } else { "" }
        throw "No visible Firefox window$suffix was found."
    }

    if ($windows.Count -gt 1) {
        Write-Warning "Multiple Firefox windows matched; using '$($windows[0].MainWindowTitle)'. Use -WindowTitle to select one."
    }

    return $windows[0]
}

function Get-AutomationRoot {
    param([System.Diagnostics.Process]$Process)

    return [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
}

function Get-BrowserTabElements {
    param([System.Windows.Automation.AutomationElement]$Root)

    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem
    )
    $allTabs = @($Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))

    # Firefox browser tabs use the stable tabbrowser-tab class. The fallback
    # keeps the helper useful if Firefox changes that class name.
    $browserTabs = @($allTabs | Where-Object {
        $_.Current.ClassName -match "(^|\s)tabbrowser-tab(\s|$)"
    })

    if ($browserTabs.Count -eq 0) {
        $browserTabs = @($allTabs | Where-Object {
            $_.Current.Name -and
            $_.Current.Name -notlike "Selected Tab:*" -and
            $_.Current.ClassName -notmatch "mdc-tab|mat-tab|leafygreen"
        })
    }

    return $browserTabs
}

function Test-Selected {
    param([System.Windows.Automation.AutomationElement]$Element)

    $selection = $null
    if ($Element.TryGetCurrentPattern(
        [System.Windows.Automation.SelectionItemPattern]::Pattern,
        [ref]$selection
    )) {
        return [bool]$selection.Current.IsSelected
    }

    return $false
}

function Focus-Firefox {
    param(
        [System.Diagnostics.Process]$Process,
        [ValidateRange(0, 10000)]
        [int]$WaitMilliseconds = 400
    )

    [AgentFirefoxUi.NativeMethods]::ShowWindow(
        $Process.MainWindowHandle,
        [AgentFirefoxUi.NativeMethods]::ShowNormal
    ) | Out-Null
    [AgentFirefoxUi.NativeMethods]::SetForegroundWindow($Process.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds $WaitMilliseconds
}

function Select-BrowserTab {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [Parameter(Mandatory)]
        [string]$Name,
        [ValidateRange(0, 10000)]
        [int]$WaitMilliseconds = 400
    )

    $tabs = @(Get-BrowserTabElements -Root $Root)
    $tab = $tabs | Where-Object { $_.Current.Name -like "*$Name*" } | Select-Object -First 1
    if (-not $tab) {
        $available = ($tabs | ForEach-Object { $_.Current.Name }) -join "; "
        throw "No browser tab matching '$Name' was found. Available tabs: $available"
    }

    $selection = $null
    if ($tab.TryGetCurrentPattern(
        [System.Windows.Automation.SelectionItemPattern]::Pattern,
        [ref]$selection
    )) {
        $selection.Select()
    } else {
        $invoke = $tab.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
    }

    Start-Sleep -Milliseconds $WaitMilliseconds
    return $tab.Current.Name
}

function Get-UiControlTypeName {
    param([System.Windows.Automation.AutomationElement]$Element)

    return $Element.Current.ControlType.ProgrammaticName -replace "^ControlType\.", ""
}

function Find-UiElements {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [string]$Name,
        [ValidateSet("Any", "Button", "Hyperlink", "MenuItem", "TabItem", "ListItem", "Text", "Edit", "CheckBox")]
        [string]$ControlType = "Any"
    )

    $elements = @($Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )) | Where-Object {
        -not $_.Current.IsOffscreen -and $_.Current.Name
    }

    if ($Name) {
        $elements = @($elements | Where-Object {
            $_.Current.Name -like "*$Name*"
        })
    }

    if ($ControlType -ne "Any") {
        $expectedType = "ControlType.$ControlType"
        $elements = @($elements | Where-Object {
            $_.Current.ControlType.ProgrammaticName -eq $expectedType
        })
    }

    return @($elements)
}

function Inspect-UiElements {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [string]$NamePattern
    )

    $regex = if ($NamePattern) {
        [regex]::new($NamePattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    } else {
        $null
    }

    foreach ($element in @(Find-UiElements -Root $Root -Name "" -ControlType "Any")) {
        $name = $element.Current.Name
        if ($regex -and -not $regex.IsMatch($name)) {
            continue
        }

        [pscustomobject]@{
            Type = Get-UiControlTypeName -Element $element
            Name = $name
            AutomationId = $element.Current.AutomationId
            ClassName = $element.Current.ClassName
            Enabled = $element.Current.IsEnabled
        }
    }
}

function Invoke-UiAction {
    param(
        [System.Windows.Automation.AutomationElement]$Root,
        [Parameter(Mandatory)]
        [string]$Name,
        [ValidateSet("Any", "Button", "Hyperlink", "MenuItem", "TabItem", "ListItem", "Text", "Edit", "CheckBox")]
        [string]$ControlType = "Any",
        [ValidateSet("invoke", "expand", "collapse")]
        [string]$Action,
        [ValidateRange(0, 10000)]
        [int]$WaitMilliseconds = 400
    )

    $elements = @(Find-UiElements -Root $Root -Name $Name -ControlType $ControlType)
    if ($elements.Count -eq 0) {
        throw "No visible UI element matched '$Name' with control type '$ControlType'."
    }

    if ($elements.Count -gt 1) {
        Write-Warning "Multiple visible elements matched; using the first '$($elements[0].Current.Name)'. Narrow with -ControlType or a more specific name."
    }

    $element = $elements[0]
    switch ($Action) {
        "invoke" {
            $pattern = $null
            if (-not $element.TryGetCurrentPattern(
                [System.Windows.Automation.InvokePattern]::Pattern,
                [ref]$pattern
            )) {
                throw "Element '$($element.Current.Name)' does not support InvokePattern."
            }
            $pattern.Invoke()
        }
        "expand" {
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            $pattern.Expand()
        }
        "collapse" {
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            $pattern.Collapse()
        }
    }

    Start-Sleep -Milliseconds $WaitMilliseconds
    return $element.Current.Name
}

function Convert-ClientPointToScreen {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$ClientX,
        [int]$ClientY
    )

    $point = New-Object AgentFirefoxUi.NativeMethods+Point
    $point.X = $ClientX
    $point.Y = $ClientY
    if (-not [AgentFirefoxUi.NativeMethods]::ClientToScreen($Process.MainWindowHandle, [ref]$point)) {
        throw "Could not convert client coordinates to screen coordinates."
    }

    return $point
}

function Click-Point {
    param(
        [System.Diagnostics.Process]$Process,
        [Parameter(Mandatory)]
        [int]$X,
        [Parameter(Mandatory)]
        [int]$Y,
        [switch]$ScreenCoordinates,
        [ValidateRange(0, 10000)]
        [int]$WaitMilliseconds = 400
    )

    $point = if ($ScreenCoordinates) {
        $screenPoint = New-Object AgentFirefoxUi.NativeMethods+Point
        $screenPoint.X = $X
        $screenPoint.Y = $Y
        $screenPoint
    } else {
        Convert-ClientPointToScreen -Process $Process -ClientX $X -ClientY $Y
    }

    [AgentFirefoxUi.NativeMethods]::SetCursorPos($point.X, $point.Y) | Out-Null
    [AgentFirefoxUi.NativeMethods]::mouse_event(
        [AgentFirefoxUi.NativeMethods]::LeftDown, 0, 0, 0, [UIntPtr]::Zero
    )
    [AgentFirefoxUi.NativeMethods]::mouse_event(
        [AgentFirefoxUi.NativeMethods]::LeftUp, 0, 0, 0, [UIntPtr]::Zero
    )

    Start-Sleep -Milliseconds $WaitMilliseconds
    return "Clicked screen coordinates ($($point.X), $($point.Y))."
}

function Get-CaptureRectangle {
    param(
        [System.Diagnostics.Process]$Process,
        [switch]$IncludeChrome,
        [ValidateRange(0, 2000)]
        [int]$CropTop = 0
    )

    if ($IncludeChrome) {
        $windowRect = New-Object AgentFirefoxUi.NativeMethods+Rect
        [AgentFirefoxUi.NativeMethods]::GetWindowRect(
            $Process.MainWindowHandle,
            [ref]$windowRect
        ) | Out-Null
        return [pscustomobject]@{
            X = $windowRect.Left
            Y = $windowRect.Top
            Width = $windowRect.Right - $windowRect.Left
            Height = $windowRect.Bottom - $windowRect.Top
        }
    }

    $clientRect = New-Object AgentFirefoxUi.NativeMethods+Rect
    [AgentFirefoxUi.NativeMethods]::GetClientRect(
        $Process.MainWindowHandle,
        [ref]$clientRect
    ) | Out-Null
    $origin = New-Object AgentFirefoxUi.NativeMethods+Point
    if (-not [AgentFirefoxUi.NativeMethods]::ClientToScreen(
        $Process.MainWindowHandle,
        [ref]$origin
    )) {
        throw "Could not locate the Firefox client area."
    }

    $height = $clientRect.Bottom - $CropTop
    if ($height -le 0) {
        throw "-CropTop is larger than the Firefox client area."
    }

    return [pscustomobject]@{
        X = $origin.X
        Y = $origin.Y + $CropTop
        Width = $clientRect.Right
        Height = $height
    }
}

function Capture-Firefox {
    param(
        [System.Diagnostics.Process]$Process,
        [string]$Destination,
        [switch]$IncludeChrome,
        [ValidateRange(0, 2000)]
        [int]$CropTop = 0
    )

    if (-not $Destination) {
        $Destination = Join-Path $env:TEMP ("firefox-ui-{0}.png" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
    }

    $resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
    $parent = Split-Path -Parent $resolvedDestination
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    $rectangle = Get-CaptureRectangle -Process $Process -IncludeChrome:$IncludeChrome -CropTop $CropTop
    $bitmap = New-Object System.Drawing.Bitmap(
        $rectangle.Width,
        $rectangle.Height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

    try {
        $graphics.CopyFromScreen(
            $rectangle.X,
            $rectangle.Y,
            0,
            0,
            $bitmap.Size,
            [System.Drawing.CopyPixelOperation]::SourceCopy
        )
        $bitmap.Save($resolvedDestination, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }

    return $resolvedDestination
}

Export-ModuleMember -Function @(
    "Get-FirefoxWindows",
    "Get-TargetFirefox",
    "Get-AutomationRoot",
    "Get-BrowserTabElements",
    "Test-Selected",
    "Focus-Firefox",
    "Select-BrowserTab",
    "Find-UiElements",
    "Inspect-UiElements",
    "Invoke-UiAction",
    "Click-Point",
    "Capture-Firefox"
)
