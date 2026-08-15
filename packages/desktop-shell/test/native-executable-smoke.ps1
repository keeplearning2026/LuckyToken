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
    [switch] $Failed
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
  return @{
    sequence = $Sequence
    modelDataPlane = $State
    provider = "unconfigured"
    dataPlane = $dataPlane
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
  Write-Frame -Stream $retryPipe -Value @{
    type = "status_result"
    requestId = "desktop-status"
    snapshot = $failedSnapshot
  }
  $retrySubscribe = Read-Frame -Stream $retryPipe
  Assert-Equal $retrySubscribe.type "subscribe" "Retry must restore the event subscription"
  Write-Frame -Stream $retryPipe -Value @{ type = "subscribed"; requestId = $retrySubscribe.requestId }
  Wait-UiText -Process $first -Text "Gateway failed"

  $second = Start-Process -FilePath $exePath -ArgumentList @("--descriptor", $descriptorPath) -PassThru
  $secondExited = $second.WaitForExit(5000)
  $first.Refresh()
  $firstSurvived = -not $first.HasExited
  $windowsAfterSecond = [LuckyTokenProductWindowProbe]::ProductWindows([uint32]$first.Id)
  $closeRequested = $first.CloseMainWindow()
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
    productWindows = $productWindows.Count
    secondInstanceExited = $secondExited
    firstInstanceSurvivedSecondLaunch = $firstSurvived
    productWindowsAfterSecondLaunch = $windowsAfterSecond.Count
    closeRequested = $closeRequested
    cleanExit = $cleanExit
    pipeClosed = $pipeClosed
  }
  $result | ConvertTo-Json -Compress | Write-Output

  if (
    -not $secondExited -or
    -not $firstSurvived -or
    $windowsAfterSecond.Count -ne 1 -or
    -not $closeRequested -or
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
