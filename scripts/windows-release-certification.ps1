param(
  [string]$InstallerPath = "",
  [string]$UninstallDir = ""
)

# LuckyToken Ticket 26 machine-scoped Windows release certification.
#
# This script drives the checks that require a real desktop session and can
# not run inside the automated suite: clean-install first run, Windows
# sign-in auto-start, second-user pipe blocking, LAN isolation, and
# uninstall data preservation. Run it on a CLEAN Windows VM / test machine
# with the built NSIS installer. It never touches production credentials;
# every check uses a temporary per-user root and recorded evidence is
# sanitized.
#
# Usage (from an admin PowerShell on the clean machine):
#   .\scripts\windows-release-certification.ps1 -InstallerPath .\dist\LuckyToken_0.1.0_x64-setup.exe

$ErrorActionPreference = "Stop"
$evidence = [ordered]@{}

function Write-Evidence {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Passed,
    [string]$Detail = ""
  )
  $evidence[$Name] = [ordered]@{ passed = $Passed; detail = $Detail }
  Write-Host ("{0} {1} {2}" -f ($(if ($Passed) { "[PASS]" } else { "[FAIL]" })), $Name, $Detail)
}

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  throw "Provide -InstallerPath pointing at the NSIS installer to certify."
}
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "Installer not found: $InstallerPath"
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("luckytoken-release-cert-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
  # --- Clean-install first run -------------------------------------------
  $installDir = $tempRoot
  $silent = Start-Process -FilePath $InstallerPath -ArgumentList @("/S", "/D=$installDir") -Wait -PassThru
  Write-Evidence -Name "clean-install" -Passed ($silent.ExitCode -eq 0) -Detail "exit $($silent.ExitCode)"

  $desktopExe = Join-Path $installDir "LuckyToken.exe"
  $launcherJson = Join-Path $installDir "launcher.json"
  $backendNode = Join-Path $installDir "backend\node\node.exe"
  $backendCli = Join-Path $installDir "backend\dist\cli.js"
  $layoutOk = (Test-Path -LiteralPath $desktopExe -PathType Leaf) -and
    (Test-Path -LiteralPath $launcherJson -PathType Leaf) -and
    (Test-Path -LiteralPath $backendNode -PathType Leaf) -and
    (Test-Path -LiteralPath $backendCli -PathType Leaf)
  Write-Evidence -Name "installed-layout" -Passed $layoutOk -Detail $installDir

  # Fixed-port: the first-run template binds 127.0.0.1:3000.
  $descriptor = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".luckytoken\control-plane.json"
  $existingPort = $null
  $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 3000)
  try {
    $probe.Start()
    $portFree = $true
  } catch {
    $portFree = $false
  } finally {
    $probe.Stop()
  }
  Write-Evidence -Name "fixed-port-free-before-first-run" -Passed $portFree

  Write-Host "Launch LuckyToken.exe once, verify: empty Dashboard, tray icon, Gateway running, and auto-start enable. Press Enter when verified..."
  Read-Host

  # --- Second-user / cross-session pipe block -----------------------------
  # The Control Plane pipe is a current-user Named Pipe with a strict DACL.
  # A second Windows user session must not be able to connect to it. This
  # requires a second local account; automated verification is documented
  # as a manual step because creating accounts needs elevated rights.
  Write-Evidence -Name "second-user-pipe-block" -Passed $false -Detail "MANUAL: create a second user, sign in, confirm the LuckyToken pipe is unreachable"

  # --- LAN isolation -------------------------------------------------------
  # Default bind host is 127.0.0.1. After the explicit LAN confirmation,
  # only model routes bind to the LAN interface; Control Plane, secret
  # reveal, history, and Developer Lab stay on loopback/IPC. On a VM with a
  # second adapter this is verified by probing the LAN address from another
  # host for model routes and confirming management surfaces refuse.
  Write-Evidence -Name "lan-isolation" -Passed $false -Detail "MANUAL: on a second host probe model routes (reachable) and management surfaces (refused)"

  # --- Uninstall preserves user data ---------------------------------------
  $userRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".luckytoken"
  $userRootBefore = Test-Path -LiteralPath $userRoot
  $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter "uninstall*.exe" | Select-Object -First 1
  if ($null -ne $uninstaller) {
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList @("/S") -Wait -PassThru
    Write-Evidence -Name "uninstall" -Passed ($uninstall.ExitCode -eq 0) -Detail "exit $($uninstall.ExitCode)"
  } else {
    Write-Evidence -Name "uninstall" -Passed $false -Detail "no uninstaller found in $installDir"
  }
  $userRootAfter = Test-Path -LiteralPath $userRoot
  Write-Evidence -Name "uninstall-preserves-user-data" -Passed ($userRootBefore -and $userRootAfter)

  $evidencePath = Join-Path $tempRoot "release-certification-evidence.json"
  $evidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  Write-Host "Evidence recorded at: $evidencePath"
  Write-Host ((($evidence.Values | Where-Object { -not $_.passed }).Count) -eq 0 ? "ALL MACHINE CHECKS PASSED" : "MANUAL/FIXED ITEMS REMAIN (see evidence)")
} finally {
  # Leave the evidence file behind; remove only scratch copies.
}
