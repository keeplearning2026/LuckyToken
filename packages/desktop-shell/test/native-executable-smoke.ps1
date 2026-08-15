$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

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

$pipe = [IO.Pipes.NamedPipeServerStream]::new(
  $pipeLeaf,
  [IO.Pipes.PipeDirection]::InOut,
  1,
  [IO.Pipes.PipeTransmissionMode]::Byte,
  [IO.Pipes.PipeOptions]::Asynchronous
)
$first = $null
$second = $null

try {
  $connection = $pipe.WaitForConnectionAsync()
  $first = Start-Process -FilePath $exePath -ArgumentList @("--descriptor", $descriptorPath) -PassThru
  if (-not $connection.Wait(10000)) { throw "Desktop did not connect to the Named Pipe fixture" }

  $hello = Read-Frame -Stream $pipe
  Assert-Equal $hello.type "hello" "First Control Plane request must be hello"
  Assert-Equal $hello.requestId "desktop-hello" "Hello request ID must be stable"
  Assert-Equal $hello.contractVersion 1 "Desktop must negotiate Control Plane v1"
  Assert-Equal $hello.capability $capability "Native bridge must use the descriptor capability"
  Write-Frame -Stream $pipe -Value @{
    type = "hello_result"
    requestId = "desktop-hello"
    result = @{
      type = "compatible"
      application = @{ id = "luckytoken"; version = "native-smoke" }
      contractVersion = 1
    }
  }

  $status = Read-Frame -Stream $pipe
  Assert-Equal $status.type "get_status" "Second Control Plane request must read status"
  Assert-Equal $status.requestId "desktop-status" "Status request ID must be stable"
  Write-Frame -Stream $pipe -Value @{
    type = "status_result"
    requestId = "desktop-status"
    snapshot = @{ sequence = 0; modelDataPlane = "running"; provider = "unconfigured" }
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
    $eof = $pipe.ReadAsync($eofBuffer, 0, 1)
    if ($eof.Wait(5000)) {
      try { $pipeClosed = $eof.Result -eq 0 } catch { $pipeClosed = $true }
    }
  } catch {
    $pipeClosed = $true
  }

  $result = [ordered]@{
    handshake = "hello(v1+capability)->get_status->subscribe"
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
  if ($second -ne $null -and -not $second.HasExited) { Stop-Process -Id $second.Id -Force }
  if ($first -ne $null -and -not $first.HasExited) { Stop-Process -Id $first.Id -Force }
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
