$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$uiaClientAssembly = [System.Reflection.Assembly]::LoadWithPartialName("UIAutomationClient")
$uiaTypesAssembly = [System.Reflection.Assembly]::LoadWithPartialName("UIAutomationTypes")
if (
  $null -eq $uiaClientAssembly -or
  $null -eq $uiaTypesAssembly -or
  $null -eq $uiaClientAssembly.Location -or
  $null -eq $uiaTypesAssembly.Location
) {
  throw "UIAutomation assemblies are required to drive the Dashboard smoke buttons"
}
Add-Type -ReferencedAssemblies @($uiaClientAssembly.Location, $uiaTypesAssembly.Location) @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public static class LuckyTokenProductWindowProbe {
  private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, StringBuilder text, int maximum);

  [DllImport("user32.dll")]
  private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool IsWindow(IntPtr window);

  private const uint WM_CLOSE = 0x0010;

  public static bool CloseProductWindow(uint processId) {
    bool any = false;
    EnumWindows((window, _) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner == processId) {
        var className = new StringBuilder(256);
        GetClassName(window, className, className.Capacity);
        if (className.ToString() == "Tauri Window") {
          PostMessage(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
          any = true;
        }
      }
      return true;
    }, IntPtr.Zero);
    return any;
  }

  // Tray icon callback message registered by the tray-icon crate
  // (tray-icon-0.24.2/src/platform_impl/windows/mod.rs: WM_USER_TRAYICON = 6002).
  private const uint WM_USER_TRAYICON = 6002;
  // Shell notification callback mouse message for opening the tray menu.
  private const uint WM_RBUTTONUP = 0x0205;
  // Win32 popup menu window class.
  private const string POPUP_MENU_CLASS = "#32768";

  public static IntPtr[] TrayWindows(uint processId) {
    var result = new List<IntPtr>();
    EnumWindows((window, _) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      var className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      if (owner == processId && className.ToString() == "tray_icon_app") {
        result.Add(window);
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }

  public static bool PostTrayRightClick(IntPtr trayWindow) {
    if (trayWindow == IntPtr.Zero || !IsWindow(trayWindow)) { return false; }
    return PostMessage(trayWindow, WM_USER_TRAYICON, IntPtr.Zero, new IntPtr(WM_RBUTTONUP));
  }

  public static IntPtr[] PopupMenus(uint processId) {
    var result = new List<IntPtr>();
    EnumWindows((window, _) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      var className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      if (owner == processId && className.ToString() == POPUP_MENU_CLASS) {
        result.Add(window);
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }

  public static bool InvokeMenuItem(IntPtr menuWindow, string name) {
    if (menuWindow == IntPtr.Zero || !IsWindow(menuWindow)) { return false; }
    AutomationElement root;
    try {
      root = AutomationElement.FromHandle(menuWindow);
    } catch (Exception) {
      return false;
    }
    var item = FindMenuItem(root, name);
    if (item == null) { return false; }
    try {
      var invoke = item.GetCurrentPattern(InvokePattern.Pattern) as InvokePattern;
      if (invoke != null) {
        invoke.Invoke();
        return true;
      }
    } catch (Exception) {}
    return false;
  }

  public static string[] MenuItemNames(IntPtr menuWindow) {
    var result = new List<string>();
    if (menuWindow == IntPtr.Zero || !IsWindow(menuWindow)) { return result.ToArray(); }
    AutomationElement root;
    try {
      root = AutomationElement.FromHandle(menuWindow);
    } catch (Exception) {
      return result.ToArray();
    }
    try {
      var items = root.FindAll(TreeScope.Descendants, new PropertyCondition(
        AutomationElement.ControlTypeProperty, ControlType.MenuItem));
      foreach (AutomationElement item in items) {
        string name;
        try {
          name = item.Current.Name;
        } catch (Exception) {
          continue;
        }
        if (!String.IsNullOrEmpty(name)) { result.Add(name); }
      }
    } catch (Exception) {}
    return result.ToArray();
  }

  private static AutomationElement FindMenuItem(AutomationElement root, string name) {
    try {
      var items = root.FindAll(TreeScope.Descendants, new PropertyCondition(
        AutomationElement.ControlTypeProperty, ControlType.MenuItem));
      foreach (AutomationElement item in items) {
        try {
          if (item.Current.Name == name) { return item; }
        } catch (Exception) {}
      }
    } catch (Exception) {}
    return null;
  }



  public static IntPtr[] ProductWindows(uint processId) {
    var result = new List<IntPtr>();
    EnumWindows((window, _) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      var title = new StringBuilder(256);
      GetWindowText(window, title, title.Capacity);
      var className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      if (
        owner == processId &&
        IsWindowVisible(window) &&
        className.ToString() == "Tauri Window" &&
        title.ToString() == "LuckyToken"
      ) {
        result.Add(window);
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }

  private static IntPtr MainWindow(uint processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, _) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      var title = new StringBuilder(256);
      GetWindowText(window, title, title.Capacity);
      var className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      if (
        owner == processId &&
        IsWindowVisible(window) &&
        className.ToString() == "Tauri Window" &&
        title.ToString() == "LuckyToken"
      ) {
        found = window;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  private static AutomationElement RootElementFor(uint processId) {
    var handle = MainWindow(processId);
    if (handle == IntPtr.Zero) { return null; }
    try {
      return AutomationElement.FromHandle(handle);
    } catch (Exception) {
      return null;
    }
  }

  private static bool TryGetName(AutomationElement element, out string name) {
    name = null;
    try {
      if (element == null) { return false; }
      name = element.Current.Name;
      return !String.IsNullOrEmpty(name);
    } catch (Exception) {
      return false;
    }
  }

  public static bool InvokeButton(uint processId, string name) {
    var root = RootElementFor(processId);
    if (root == null) { return false; }
    var element = FindButton(root, name);
    if (element == null) { return false; }
    try {
      var pattern = element.GetCurrentPattern(InvokePattern.Pattern) as InvokePattern;
      if (pattern == null) { return false; }
      pattern.Invoke();
      return true;
    } catch (Exception) {
      return false;
    }
  }

  private static AutomationElement FindButton(AutomationElement root, string name) {
    AutomationElementCollection children;
    try {
      children = root.FindAll(TreeScope.Children, Condition.TrueCondition);
    } catch (Exception) {
      return null;
    }
    foreach (AutomationElement child in children) {
      string childName;
      if (TryGetName(child, out childName) && childName == name) {
        try {
          if (child.Current.ControlType == ControlType.Button && child.Current.IsEnabled) {
            return child;
          }
        } catch (Exception) {}
      }
      var deeper = FindButton(child, name);
      if (deeper != null) { return deeper; }
    }
    return null;
  }

  public static bool HasText(uint processId, string text) {
    var root = RootElementFor(processId);
    if (root == null) { return false; }
    return ContainsText(root, text);
  }

  private static bool ContainsText(AutomationElement root, string text) {
    string rootName;
    if (TryGetName(root, out rootName) && rootName.Contains(text)) { return true; }
    AutomationElementCollection children;
    try {
      children = root.FindAll(TreeScope.Children, Condition.TrueCondition);
    } catch (Exception) {
      return false;
    }
    foreach (AutomationElement child in children) {
      if (ContainsText(child, text)) { return true; }
    }
    return false;
  }

  public static string[] Names(uint processId) {
    var result = new List<string>();
    var root = RootElementFor(processId);
    if (root == null) { return result.ToArray(); }
    CollectNames(root, result);
    return result.ToArray();
  }

  private static void CollectNames(AutomationElement root, List<string> result) {
    string rootName;
    if (TryGetName(root, out rootName)) { result.Add(rootName); }
    AutomationElementCollection children;
    try {
      children = root.FindAll(TreeScope.Children, Condition.TrueCondition);
    } catch (Exception) {
      return;
    }
    foreach (AutomationElement child in children) {
      CollectNames(child, result);
    }
  }
}
'@

function Read-Exact {
  param(
    [Parameter(Mandatory = $true)] [System.IO.Stream] $Stream,
    [Parameter(Mandatory = $true)] [int] $Length
  )
  $buffer = [byte[]]::new($Length)
  $offset = 0
  while ($offset -lt $Length) {
    $read = $Stream.Read($buffer, $offset, $Length - $offset)
    if ($read -eq 0) { throw "Named Pipe closed before a complete frame arrived" }
    $offset += $read
  }
  Write-Output -NoEnumerate $buffer
}

function Read-Frame {
  param([Parameter(Mandatory = $true)] [System.IO.Stream] $Stream)
  $header = Read-Exact -Stream $Stream -Length 4
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
  $length = [BitConverter]::ToUInt32($header, 0)
  if ($length -eq 0 -or $length -gt 1MB) { throw "Named Pipe frame length is invalid" }
  $body = Read-Exact -Stream $Stream -Length $length
  return [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
}

function Write-Frame {
  param(
    [Parameter(Mandatory = $true)] [System.IO.Stream] $Stream,
    [Parameter(Mandatory = $true)] [object] $Value
  )
  $body = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Compress -Depth 8))
  $header = [BitConverter]::GetBytes([uint32]$body.Length)
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
  $Stream.Write($header, 0, $header.Length)
  $Stream.Write($body, 0, $body.Length)
  $Stream.Flush()
}

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)] $Actual,
    [Parameter(Mandatory = $true)] $Expected,
    [Parameter(Mandatory = $true)] [string] $Message
  )
  if ($Actual -ne $Expected) { throw "$Message (expected '$Expected', got '$Actual')" }
}

function New-PipeServer {
  param([Parameter(Mandatory = $true)] [string] $PipeLeaf)
  return [IO.Pipes.NamedPipeServerStream]::new(
    $PipeLeaf,
    [IO.Pipes.PipeDirection]::InOut,
    5,
    [IO.Pipes.PipeTransmissionMode]::Byte,
    [IO.Pipes.PipeOptions]::Asynchronous
  )
}

function Wait-UiText {
  param(
    [Parameter(Mandatory = $true)] [Diagnostics.Process] $Process,
    [Parameter(Mandatory = $true)] [string] $Text
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if ([LuckyTokenProductWindowProbe]::HasText([uint32]$Process.Id, $Text)) { return }
    Start-Sleep -Milliseconds 50
    $Process.Refresh()
  } while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  $names = [LuckyTokenProductWindowProbe]::Names([uint32]$Process.Id) -join " | "
  throw "Desktop UI did not expose '$Text'. Visible names: $names"
}

function Get-ProductWindows {
  param([Parameter(Mandatory = $true)] [Diagnostics.Process] $Process)
  return [LuckyTokenProductWindowProbe]::ProductWindows([uint32]$Process.Id)
}

function Wait-ProductWindowCount {
  param(
    [Parameter(Mandatory = $true)] [Diagnostics.Process] $Process,
    [Parameter(Mandatory = $true)] [int] $Count
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $windows = @([LuckyTokenProductWindowProbe]::ProductWindows([uint32]$Process.Id))
    $Process.Refresh()
    if ($windows.Count -eq $Count) { return $windows }
    Start-Sleep -Milliseconds 50
  } while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  throw "Expected exactly $Count visible LuckyToken window(s), found $($windows.Count)"
}

function Wait-TrayWindowCount {
  param(
    [Parameter(Mandatory = $true)] [Diagnostics.Process] $Process,
    [Parameter(Mandatory = $true)] [int] $Count
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $trayWindows = @([LuckyTokenProductWindowProbe]::TrayWindows([uint32]$Process.Id))
    $Process.Refresh()
    if ($trayWindows.Count -eq $Count) { return $trayWindows }
    Start-Sleep -Milliseconds 50
  } while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  throw "Expected exactly $Count tray icon window(s), found $($trayWindows.Count)"
}

function Open-TrayMenu {
  param(
    [Parameter(Mandatory = $true)] [Diagnostics.Process] $Process,
    [Parameter(Mandatory = $true)] [IntPtr] $TrayWindow
  )
  if (-not [LuckyTokenProductWindowProbe]::PostTrayRightClick($TrayWindow)) {
    throw "Tray right-click callback could not be posted"
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $menus = [LuckyTokenProductWindowProbe]::PopupMenus([uint32]$Process.Id)
    if ($menus.Count -eq 1) {
      $names = [LuckyTokenProductWindowProbe]::MenuItemNames($menus[0])
      if ($names.Count -ge 3) { return $menus[0] }
    }
    Start-Sleep -Milliseconds 50
  } while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  $foundNames = if ($menus.Count -eq 1) {
    [LuckyTokenProductWindowProbe]::MenuItemNames($menus[0]) -join " | "
  } else { "no popup menu" }
  throw "Tray popup menu with items did not open. Visible: $foundNames"
}

function Invoke-TrayMenuItem {
  param(
    [Parameter(Mandatory = $true)] [Diagnostics.Process] $Process,
    [Parameter(Mandatory = $true)] [IntPtr] $MenuWindow,
    [Parameter(Mandatory = $true)] [string] $Name
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if ([LuckyTokenProductWindowProbe]::InvokeMenuItem($MenuWindow, $Name)) { return }
    Start-Sleep -Milliseconds 50
    $Process.Refresh()
  } while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  $names = [LuckyTokenProductWindowProbe]::MenuItemNames($MenuWindow) -join " | "
  throw "Tray menu item '$Name' was not invokable. Visible items: $names"
}

function Invoke-UiButton {
  param(
    [Parameter(Mandatory = $true)] [Diagnostics.Process] $Process,
    [Parameter(Mandatory = $true)] [string] $Name
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if ([LuckyTokenProductWindowProbe]::InvokeButton([uint32]$Process.Id, $Name)) { return }
    Start-Sleep -Milliseconds 50
    $Process.Refresh()
  } while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  throw "Desktop UI button '$Name' was not enabled"
}

function New-StatusSnapshot {
  param(
    [Parameter(Mandatory = $true)] [int] $Sequence,
    [Parameter(Mandatory = $true)] [string] $State,
    [switch] $Failed,
    [switch] $WithSettings
  )
  $dataPlane = @{
    configuredOrigin = "http://127.0.0.1:3000"
    configuredPort = 3000
  }
  if ($Failed) {
    $dataPlane.failure = @{
      code = "port_in_use"
      message = "raw-native-failure-secret"
    }
  }
  $snapshot = @{
    sequence = $Sequence
    modelDataPlane = $State
    provider = "unconfigured"
    dataPlane = $dataPlane
    ownership = @{
      owner = @{
        kind = "cli"
        pid = 4242
        startedAt = "2026-08-15T12:00:00.000Z"
      }
    }
  }
  if ($WithSettings) {
    $snapshot.settings = @{
      "protocols.anthropic-messages.enabled" = @{
        key = "protocols.anthropic-messages.enabled"
        type = "boolean"
        default = $false
        validation = "boolean"
        sensitivity = "public"
        applyMode = "hot-apply"
        value = $true
      }
      "protocols.openai-responses.enabled" = @{
        key = "protocols.openai-responses.enabled"
        type = "boolean"
        default = $false
        validation = "boolean"
        sensitivity = "public"
        applyMode = "hot-apply"
        value = $false
      }
      "server.port" = @{
        key = "server.port"
        type = "number"
        default = 3000
        validation = "port"
        sensitivity = "public"
        applyMode = "restart-required"
        value = 3000
      }
      "credentials.secret-token" = @{
        key = "credentials.secret-token"
        type = "string"
        default = ""
        validation = "secret"
        sensitivity = "secret"
        applyMode = "hot-apply"
        value = "secret-token-setting"
      }
    }
  }
  return $snapshot
}


function Serve-BridgeQuery {
  # Serves one of the renderer's one-shot bridge queries (Windows sign-in
  # auto-start status or Dashboard diagnostics warnings) on a freshly created
  # pipe instance, dispatching on whichever frame arrives.
  param([Parameter(Mandatory = $true)] [string] $Label)
  $pipe = New-PipeServer -PipeLeaf $script:pipeLeaf
  try {
    $connection = $pipe.WaitForConnectionAsync()
    if (-not $connection.Wait(15000)) {
      throw "$Label did not open a native pipe"
    }
    return Serve-ConnectedQuery -Pipe $pipe -Label $Label
  } finally {
    $pipe.Dispose()
  }
}

function Serve-ConnectedQuery {
  # Serves an already-connected bridge query pipe: hello, then dispatch on
  # the first frame (auto-start status vs diagnostics warnings).
  param(
    [Parameter(Mandatory = $true)] $Pipe,
    [Parameter(Mandatory = $true)] [string] $Label
  )
  try {
    Complete-Hello -Stream $Pipe
    $request = Read-Frame -Stream $pipe
    if ($request.type -eq "application_command") {
      Assert-Equal $request.command.command "auto_start" "Bridge command must be auto_start"
      Assert-Equal $request.command.action "status" "Bridge auto-start action must be status"
      Write-Frame -Stream $Pipe -Value @{
        type = "application_command_result"
        requestId = $request.requestId
        result = @{
          command = "auto_start"
          outcome = "ok"
          autoStart = @{ enabled = $false }
          snapshot = (New-StatusSnapshot -Sequence 2 -State "running")
        }
      }
      return "auto_start"
    }
    if ($request.type -eq "get_diagnostics") {
      Write-Frame -Stream $Pipe -Value @{
        type = "diagnostics_result"
        requestId = $request.requestId
        result = @{ records = @(); hasMore = $false }
      }
      return "diagnostics"
    }
    throw "$Label received an unexpected frame: $($request.type)"
  } finally {
    $Pipe.Dispose()
  }
}

function Invoke-AutoStartAction {
  param(
    [Parameter(Mandatory = $true)] [string] $ButtonName,
    [Parameter(Mandatory = $true)] [string] $Action,
    [Parameter(Mandatory = $true)] [bool] $Enabled
  )
  # The native client fails fast when no server instance is listening, so
  # the fixture must be waiting BEFORE the renderer's invoke fires.
  $autoStartPipe = New-PipeServer -PipeLeaf $script:pipeLeaf
  try {
    $connection = $autoStartPipe.WaitForConnectionAsync()
    Invoke-UiButton -Process $script:first -Name $ButtonName
    if (-not $connection.Wait(10000)) {
      $visibleNames = if ($null -ne $script:first) {
        [LuckyTokenProductWindowProbe]::Names([uint32]$script:first.Id) -join " | "
      } else { "no first process" }
      throw "Auto-start $Action did not open a native pipe. UI names: $visibleNames"
    }
    Complete-Hello -Stream $autoStartPipe
    $request = Read-Frame -Stream $autoStartPipe
    Assert-Equal $request.type "application_command" "Auto-start must use application_command"
    Assert-Equal $request.command.command "auto_start" "Auto-start command must be preserved"
    Assert-Equal $request.command.action $Action "Auto-start action must be preserved"
    Write-Frame -Stream $autoStartPipe -Value @{
      type = "application_command_result"
      requestId = $request.requestId
      result = @{
        command = "auto_start"
        outcome = "ok"
        autoStart = @{ enabled = $Enabled }
        snapshot = (New-StatusSnapshot -Sequence 2 -State "running")
      }
    }
  } finally {
    $autoStartPipe.Dispose()
  }
}

function Complete-Hello {
  param([Parameter(Mandatory = $true)] [IO.Stream] $Stream)
  $hello = Read-Frame -Stream $Stream
  Assert-Equal $hello.type "hello" "Control Plane connection must begin with hello"
  Assert-Equal $hello.requestId "desktop-hello" "Hello request ID must be stable"
  Assert-Equal $hello.contractVersion 1 "Desktop must negotiate Control Plane v1"
  Assert-Equal $hello.capability $script:capability "Native bridge must use the descriptor capability"
  Write-Frame -Stream $Stream -Value @{
    type = "hello_result"
    requestId = "desktop-hello"
    result = @{
      type = "compatible"
      application = @{ id = "luckytoken"; version = "native-smoke" }
      contractVersion = 1
    }
  }
}

function Write-StatusEvent {
  param(
    [Parameter(Mandatory = $true)] [IO.Stream] $Stream,
    [Parameter(Mandatory = $true)] [object] $Snapshot
  )
  Write-Frame -Stream $Stream -Value @{
    type = "event"
    event = @{
      type = "status_changed"
      sequence = $Snapshot.sequence
      snapshot = $Snapshot
    }
  }
}

function Invoke-RuntimeCommand {
  param(
    [Parameter(Mandatory = $true)] [Diagnostics.Process] $Process,
    [Parameter(Mandatory = $true)] [IO.Stream] $Subscription,
    [Parameter(Mandatory = $true)] [string] $Command,
    [Parameter(Mandatory = $true)] [object[]] $Transitions,
    [Parameter(Mandatory = $true)] [object] $ResultSnapshot,
    [Parameter(Mandatory = $true)] [string] $Outcome
  )
  $commandPipe = New-PipeServer -PipeLeaf $script:pipeLeaf
  try {
    $connection = $commandPipe.WaitForConnectionAsync()
    $buttonName = (Get-Culture).TextInfo.ToTitleCase($Command)
    Invoke-UiButton -Process $Process -Name $buttonName
    if (-not $connection.Wait(10000)) { throw "$Command command did not open a native pipe" }
    Complete-Hello -Stream $commandPipe
    $request = Read-Frame -Stream $commandPipe
    Assert-Equal $request.type "runtime_command" "Dashboard $Command must use runtime_command"
    Assert-Equal $request.command $Command "Dashboard command must preserve its semantic name"
    foreach ($transition in $Transitions) {
      Write-StatusEvent -Stream $Subscription -Snapshot $transition.snapshot
      Wait-UiText -Process $Process -Text $transition.text
    }
    Write-Frame -Stream $commandPipe -Value @{
      type = "runtime_command_result"
      requestId = $request.requestId
      result = @{
        command = $Command
        outcome = $Outcome
        snapshot = $ResultSnapshot
      }
    }
  } finally {
    $commandPipe.Dispose()
  }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "LuckyToken native desktop smoke requires Windows"
}

$packageDirectory = Split-Path -Parent $PSScriptRoot
$exePath = Join-Path $packageDirectory "src-tauri\target\release\luckytoken-desktop.exe"
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
  throw "Native desktop executable was not built: $exePath"
}

$smokeId = [Guid]::NewGuid().ToString("N")
$pipeLeaf = "luckytoken-desktop-smoke-$smokeId"
$pipeName = "\\.\pipe\$pipeLeaf"
$capability = "desktop-smoke-capability-$smokeId"
$smokeDirectory = Join-Path ([IO.Path]::GetTempPath()) "luckytoken-desktop-smoke-$smokeId"
$descriptorPath = Join-Path $smokeDirectory "control-plane.json"
[IO.Directory]::CreateDirectory($smokeDirectory) | Out-Null
$descriptorJson = @{ pipeName = $pipeName; capability = $capability } | ConvertTo-Json -Compress
[IO.File]::WriteAllText(
  $descriptorPath,
  $descriptorJson,
  (New-Object Text.UTF8Encoding($false))
)

$pipe = New-PipeServer -PipeLeaf $pipeLeaf
$first = $null
$second = $null
$retryPipe = $null

try {
  $connection = $pipe.WaitForConnectionAsync()
  $first = Start-Process -FilePath $exePath -ArgumentList @("--descriptor", $descriptorPath) -PassThru
  if (-not $connection.Wait(10000)) { throw "Desktop did not connect to the Named Pipe fixture" }

  Complete-Hello -Stream $pipe

  $start = Read-Frame -Stream $pipe
  Assert-Equal $start.type "runtime_command" "Second Control Plane request must start the gateway"
  Assert-Equal $start.requestId "desktop-start" "Start request ID must be stable"
  Assert-Equal $start.command "start" "Opening desktop must request start exactly once"
  Write-Frame -Stream $pipe -Value @{
    type = "runtime_command_result"
    requestId = "desktop-start"
    result = @{
      command = "start"
      outcome = "completed"
      snapshot = (New-StatusSnapshot -Sequence 2 -State "running")
    }
  }

  $subscribe = Read-Frame -Stream $pipe
  Assert-Equal $subscribe.type "subscribe" "Third Control Plane request must subscribe"
  Assert-Equal $subscribe.requestId "desktop-subscribe" "Subscribe request ID must be stable"
  Write-Frame -Stream $pipe -Value @{ type = "subscribed"; requestId = "desktop-subscribe" }

  # --- Ticket 05/16: ownership projection, auto-start, and warnings --------
  # The renderer fires one-shot bridge queries (sign-in auto-start status and
  # Dashboard diagnostics warnings) right after the first connected render.
  # The fixture must already be listening, because the native client fails
  # fast when no server instance exists.
  $bridgeQueryPipes = @(
    (New-PipeServer -PipeLeaf $pipeLeaf),
    (New-PipeServer -PipeLeaf $pipeLeaf)
  )
  foreach ($queryPipe in $bridgeQueryPipes) {
    $null = $queryPipe.WaitForConnectionAsync()
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 200
    $first.Refresh()
    $productWindows = [LuckyTokenProductWindowProbe]::ProductWindows([uint32]$first.Id)
  } while (
    $productWindows.Count -ne 1 -and
    -not $first.HasExited -and
    [DateTime]::UtcNow -lt $deadline
  )
  if ($first.HasExited -or $productWindows.Count -ne 1) {
    throw "Exactly one LuckyToken product window did not become visible"
  }

  Wait-UiText -Process $first -Text "Gateway running"
  $firstQuery = Serve-ConnectedQuery -Pipe $bridgeQueryPipes[0] -Label "First bridge query"
  $secondQuery = Serve-ConnectedQuery -Pipe $bridgeQueryPipes[1] -Label "Second bridge query"
  $autoStartServed = ($firstQuery -eq "auto_start") -or ($secondQuery -eq "auto_start")
  $diagnosticsServed = ($firstQuery -eq "diagnostics") -or ($secondQuery -eq "diagnostics")
  if (-not $autoStartServed -or -not $diagnosticsServed) {
    throw "Bridge queries must include auto-start status and diagnostics warnings (got $firstQuery, $secondQuery)"
  }
  Wait-UiText -Process $first -Text "Owned by the headless LuckyToken CLI (PID 4242)"
  Wait-UiText -Process $first -Text "Does not start at sign-in"
  Invoke-AutoStartAction -ButtonName "Enable auto-start" -Action "enable" -Enabled $true
  Wait-UiText -Process $first -Text "Starts LuckyToken at sign-in"
  Invoke-AutoStartAction -ButtonName "Disable auto-start" -Action "disable" -Enabled $false
  Wait-UiText -Process $first -Text "Does not start at sign-in"
  Invoke-RuntimeCommand -Process $first -Subscription $pipe -Command "stop" -Outcome "completed" -Transitions @(
    @{ snapshot = (New-StatusSnapshot -Sequence 3 -State "stopping"); text = "Gateway stopping" },
    @{ snapshot = (New-StatusSnapshot -Sequence 4 -State "stopped"); text = "Gateway stopped" }
  ) -ResultSnapshot (New-StatusSnapshot -Sequence 4 -State "stopped")
  Invoke-RuntimeCommand -Process $first -Subscription $pipe -Command "start" -Outcome "completed" -Transitions @(
    @{ snapshot = (New-StatusSnapshot -Sequence 5 -State "starting"); text = "Gateway starting" },
    @{ snapshot = (New-StatusSnapshot -Sequence 6 -State "running"); text = "Gateway running" }
  ) -ResultSnapshot (New-StatusSnapshot -Sequence 6 -State "running")
  $failedSnapshot = New-StatusSnapshot -Sequence 9 -State "failed" -Failed
  Invoke-RuntimeCommand -Process $first -Subscription $pipe -Command "restart" -Outcome "failed" -Transitions @(
    @{ snapshot = New-StatusSnapshot -Sequence 7 -State "stopping"; text = "Gateway stopping" },
    @{ snapshot = New-StatusSnapshot -Sequence 8 -State "starting"; text = "Gateway starting" },
    @{ snapshot = $failedSnapshot; text = "Gateway failed" }
  ) -ResultSnapshot $failedSnapshot
  Wait-UiText -Process $first -Text "http://127.0.0.1:3000"
  Wait-UiText -Process $first -Text "The configured port is already in use. Stop the other application or choose a different port."
  if ([LuckyTokenProductWindowProbe]::HasText([uint32]$first.Id, "raw-native-failure-secret")) {
    throw "Raw native failure text crossed the renderer allowlist"
  }

  $pipe.Dispose()
  Wait-UiText -Process $first -Text "Connection to LuckyToken was lost"
  $retryPipe = New-PipeServer -PipeLeaf $pipeLeaf
  $retryConnection = $retryPipe.WaitForConnectionAsync()
  Invoke-UiButton -Process $first -Name "Retry"
  if (-not $retryConnection.Wait(10000)) { throw "Retry did not reconnect to the native pipe" }
  Complete-Hello -Stream $retryPipe
  $retryStatus = Read-Frame -Stream $retryPipe
  Assert-Equal $retryStatus.type "get_status" "Retry must query status without a second automatic Start"
  Assert-Equal $retryStatus.requestId "desktop-status" "Retry status request ID must be stable"
  # The reconnected session is a new connected session: the renderer queries
  # the sign-in registration once more. Listen BEFORE the status result so
  # the one-shot query always finds a server.
  $retryQueryPipes = @(
    (New-PipeServer -PipeLeaf $pipeLeaf),
    (New-PipeServer -PipeLeaf $pipeLeaf)
  )
  foreach ($retryQueryPipe in $retryQueryPipes) {
    $null = $retryQueryPipe.WaitForConnectionAsync()
  }
  Write-Frame -Stream $retryPipe -Value @{
    type = "status_result"
    requestId = "desktop-status"
    snapshot = $failedSnapshot
  }
  $retrySubscribe = Read-Frame -Stream $retryPipe
  Assert-Equal $retrySubscribe.type "subscribe" "Retry must restore the event subscription"
  Write-Frame -Stream $retryPipe -Value @{ type = "subscribed"; requestId = $retrySubscribe.requestId }
  Wait-UiText -Process $first -Text "Gateway failed"
  $retryFirst = Serve-ConnectedQuery -Pipe $retryQueryPipes[0] -Label "Retry first bridge query"
  $retrySecond = Serve-ConnectedQuery -Pipe $retryQueryPipes[1] -Label "Retry second bridge query"
  if (
    (($retryFirst -eq "auto_start") -or ($retrySecond -eq "auto_start")) -and
    (($retryFirst -eq "diagnostics") -or ($retrySecond -eq "diagnostics"))
  ) {
    # The reconnected session re-queries both one-shot bridge queries.
  } else {
    throw "Retry bridge queries must include auto-start and diagnostics (got $retryFirst, $retrySecond)"
  }

  # --- Ticket 06: settings projection through the public native seam --------
  # A status event carrying registered public settings reaches the renderer
  # allowlist through the live bridge, and the Settings / Developer Lab page
  # renders them (the settings_command wire itself is covered by the Rust
  # unit test settings_command_exchanges_the_versioned_wire_and_decodes_the_result
  # and the runtime command-routing test).
  $settingsSnapshot = New-StatusSnapshot -Sequence 12 -State "running" -WithSettings
  Write-StatusEvent -Stream $retryPipe -Snapshot $settingsSnapshot
  Invoke-UiButton -Process $first -Name "Settings / Developer Lab"
  Wait-UiText -Process $first -Text "Anthropic Messages"
  Wait-UiText -Process $first -Text "OpenAI Responses"
  Wait-UiText -Process $first -Text "Data Plane listener"
  if ([LuckyTokenProductWindowProbe]::HasText([uint32]$first.Id, "No registered protocol settings")) {
    throw "Registered public settings did not reach the renderer allowlist"
  }
  # Secret settings never reach the renderer: the fixture carries one secret
  # setting that must not be rendered.
  if ([LuckyTokenProductWindowProbe]::HasText([uint32]$first.Id, "secret-token-setting")) {
    throw "Secret setting leaked into the renderer"
  }

  $second = Start-Process -FilePath $exePath -ArgumentList @("--descriptor", $descriptorPath) -PassThru
  $secondExited = $second.WaitForExit(5000)
  $first.Refresh()
  $firstSurvived = -not $first.HasExited
  $windowsAfterSecond = @(Get-ProductWindows -Process $first)

  # --- Ticket 04: tray Close/Show/Quit entry points -------------------------
  # Exactly one tray icon must exist before any window interaction.
  $trayWindows = @(Wait-TrayWindowCount -Process $first -Count 1)
  $trayWindow = $trayWindows[0]

  # Close-to-tray: closing the main window hides it, the application stays
  # alive, and the tray icon remains available.
  # Post WM_CLOSE directly to the Tauri Window: .NET CloseMainWindow() may
  # target a different top-level window than the product window.
  $closeRequested = [LuckyTokenProductWindowProbe]::CloseProductWindow([uint32]$first.Id)
  Start-Sleep -Milliseconds 100
  $hiddenWindows = Wait-ProductWindowCount -Process $first -Count 0
  $first.Refresh()
  $aliveAfterClose = -not $first.HasExited
  $trayWindowsAfterClose = @(Wait-TrayWindowCount -Process $first -Count 1)

  # The Data Plane remains reachable while hidden: the live subscription pipe
  # is still open and the gateway reports state updates through it.
  Write-StatusEvent -Stream $retryPipe -Snapshot (New-StatusSnapshot -Sequence 11 -State "stopped")
  Start-Sleep -Milliseconds 200
  $first.Refresh()
  $dataPlaneReachableWhileHidden = -not $first.HasExited -and -not $retryPipe.CanRead -eq $false
  $hiddenSubscriptionOpen = -not $retryPipe.CanRead -eq $false

  # Repeated Close is idempotent: no second tray icon, no second window, and
  # the same tray window handle survives every Close/Show cycle.
  $null = [LuckyTokenProductWindowProbe]::CloseProductWindow([uint32]$first.Id)
  $trayWindowsAfterSecondClose = @(Wait-TrayWindowCount -Process $first -Count 1)
  if (-not ([int64]$trayWindows[0] -eq [int64]$trayWindowsAfterClose[0]) -or
      -not ([int64]$trayWindowsAfterClose[0] -eq [int64]$trayWindowsAfterSecondClose[0])) {
    throw "Tray icon window changed across Close/Show cycles"
  }
  $hiddenAfterSecondClose = @(Get-ProductWindows -Process $first).Count -eq 0

  # The tray menu exposes sanitized high-level gateway state: the disabled
  # status line and the Show/Quit commands, with no credentials or secrets.
  # (Opened while hidden; the window must stay hidden while the menu is up.)
  $menuWindow = Open-TrayMenu -Process $first -TrayWindow $trayWindow
  $menuNames = [LuckyTokenProductWindowProbe]::MenuItemNames($menuWindow)
  if ($menuNames -notcontains "Show LuckyToken" -or $menuNames -notcontains "Quit LuckyToken") {
    throw "Tray menu must expose Show and Quit. Visible: $($menuNames -join ' | ')"
  }
  $trayStatusLine = $menuNames | Where-Object { $_ -like "LuckyToken*" } | Select-Object -First 1
  if ($null -eq $trayStatusLine) {
    throw "Tray menu must expose a high-level gateway status line"
  }
  $secretFree = -not (($menuNames -join " ") -match "3000|127\.0\.0\.1|capability|desktop-smoke|raw-native-failure-secret")
  if (-not $secretFree) {
    throw "Tray menu leaked a secret or transport detail: $($menuNames -join ' | ')"
  }

  # Tray Show restores and focuses the same existing window; never a second.
  Invoke-TrayMenuItem -Process $first -MenuWindow $menuWindow -Name "Show LuckyToken"
  $shownWindows = @(Wait-ProductWindowCount -Process $first -Count 1)
  if ($shownWindows[0] -ne $windowsAfterSecond[0]) {
    throw "Tray Show created a different window handle instead of restoring the existing one"
  }

  # Tray Quit is the distinct explicit quit intent: the process exits, while
  # window Close alone never does.
  $menuWindow = Open-TrayMenu -Process $first -TrayWindow $trayWindow
  Invoke-TrayMenuItem -Process $first -MenuWindow $menuWindow -Name "Quit LuckyToken"
  $cleanExit = $first.WaitForExit(10000)

  $pipeClosed = $false
  try {
    $eofBuffer = [byte[]]::new(1)
    $eof = $retryPipe.ReadAsync($eofBuffer, 0, 1)
    if ($eof.Wait(5000)) {
      try { $pipeClosed = $eof.Result -eq 0 } catch { $pipeClosed = $true }
    }
  } catch {
    $pipeClosed = $true
  }

  $result = [ordered]@{
    handshake = "first:hello->start->subscribe; dashboard:stop,start,restart; retry:hello->get_status->subscribe"
    orderedTransitions = "stopping->stopped; starting->running; stopping->starting->failed"
    failureProjection = "fixed-origin+closed-port_in_use-message"
    retryAutoStarts = 0
    productWindows = @($productWindows).Count
    secondInstanceExited = $secondExited
    firstInstanceSurvivedSecondLaunch = $firstSurvived
    productWindowsAfterSecondLaunch = @($windowsAfterSecond).Count
    trayWindows = @($trayWindowsAfterClose).Count
    closeRequested = $closeRequested
    aliveAfterClose = $aliveAfterClose
    hiddenWindows = @($hiddenWindows).Count
    hiddenAfterSecondClose = $hiddenAfterSecondClose
    dataPlaneReachableWhileHidden = $dataPlaneReachableWhileHidden
    hiddenSubscriptionOpen = $hiddenSubscriptionOpen
    trayWindowStableAcrossCloseShow = $true
    trayShowRestoredExistingWindow = ([int64]$shownWindows[0] -eq [int64]$windowsAfterSecond[0])
    trayMenuSecretFree = $secretFree
    quitViaTray = $cleanExit
    cleanExit = $cleanExit
    pipeClosed = $pipeClosed
    ownershipProjected = $true
    autoStartStatusQueried = $true
    autoStartToggled = $true
  }
  $result | ConvertTo-Json -Compress | Write-Output

  if (
    -not $secondExited -or
    -not $firstSurvived -or
    @($windowsAfterSecond).Count -ne 1 -or
    -not $closeRequested -or
    -not $aliveAfterClose -or
    @($hiddenWindows).Count -ne 0 -or
    -not $hiddenAfterSecondClose -or
    @($trayWindowsAfterClose).Count -ne 1 -or
    @($trayWindowsAfterSecondClose).Count -ne 1 -or
    -not $dataPlaneReachableWhileHidden -or
    -not $hiddenSubscriptionOpen -or
    -not $secretFree -or
    -not $result.trayShowRestoredExistingWindow -or
    -not $cleanExit -or
    -not $pipeClosed
  ) {
    throw "LuckyToken native desktop smoke failed"
  }
} finally {
  # Graceful window close first so WebView2 exits cleanly; a Force kill can
  # leave an orphaned browser process that blocks the next run's connection.
  if ($first -ne $null -and -not $first.HasExited) {
    $null = $first.CloseMainWindow()
    if (-not $first.WaitForExit(10000)) { Stop-Process -Id $first.Id -Force }
  }
  if ($second -ne $null -and -not $second.HasExited) { Stop-Process -Id $second.Id -Force }
  if ($retryPipe -ne $null) { $retryPipe.Dispose() }
  $pipe.Dispose()
  if (Test-Path -LiteralPath $smokeDirectory) {
    $resolvedSmokeDirectory = (Resolve-Path -LiteralPath $smokeDirectory).Path
    $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedSmokeDirectory.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Smoke cleanup path escaped the system temporary directory"
    }
    Remove-Item -LiteralPath $resolvedSmokeDirectory -Recurse -Force
  }
}
