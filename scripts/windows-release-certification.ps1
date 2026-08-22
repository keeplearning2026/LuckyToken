param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$installRoot = Join-Path $env:LOCALAPPDATA "LuckyToken"
$installedExe = Join-Path $installRoot "app-$Version\LuckyToken.exe"
$updateExe = Join-Path $installRoot "Update.exe"
$userState = Join-Path $env:USERPROFILE ".luckytoken"
$descriptorPath = Join-Path $userState "control-plane.json"
$evidence = [ordered]@{
  schemaVersion = "luckytoken-windows-installer-certification-v1"
  installer = $resolvedInstaller
  version = $Version
  startedAt = [DateTimeOffset]::UtcNow.ToString("o")
  checks = [ordered]@{}
}

function Add-Check {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Passed,
    [string]$Detail = ""
  )
  $evidence.checks[$Name] = [ordered]@{ passed = $Passed; detail = $Detail }
  if (-not $Passed) { throw "$Name failed: $Detail" }
  Write-Host "[PASS] $Name $Detail"
}

function Wait-ReleaseProcess {
  param(
    [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    throw "$Label timed out after $TimeoutMilliseconds ms"
  }
  if ($Process.ExitCode -ne 0) {
    throw "$Label exited with code $($Process.ExitCode)"
  }
}

if (-not [IO.Path]::IsPathFullyQualified($resolvedInstaller)) {
  throw "InstallerPath must resolve to an absolute path"
}
if (Test-Path -LiteralPath $installedExe -PathType Leaf) {
  throw "Installer certification requires a clean Windows user; already installed: $installedExe"
}
if (Test-Path -LiteralPath $userState) {
  throw "Installer certification requires a blank Windows user; state already exists: $userState"
}
if ($RequireSignature) {
  $signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
  Add-Check -Name "installer-signature" -Passed ($signature.Status -eq "Valid") -Detail $signature.Status
}

$testCodexHome = [IO.Path]::GetFullPath(
  (Join-Path ([IO.Path]::GetTempPath()) ("luckytoken-windows-cert-codex-{0}" -f [Guid]::NewGuid().ToString("N")))
)
$testTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $testCodexHome.StartsWith($testTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Temporary Codex home escaped the system temp directory: $testCodexHome"
}
$previousCodexHomeEnvironment = $env:CODEX_HOME
New-Item -ItemType Directory -Path $testCodexHome -Force | Out-Null
$env:CODEX_HOME = $testCodexHome

try {
  $setupProcess = Start-Process -FilePath $resolvedInstaller -ArgumentList @("--silent") -PassThru -WindowStyle Hidden
  Wait-ReleaseProcess -Process $setupProcess -TimeoutMilliseconds 300000 -Label "Squirrel installer"
  Add-Check -Name "clean-install" -Passed $true -Detail "exit 0"

  Add-Check -Name "installed-executable" -Passed (Test-Path -LiteralPath $installedExe -PathType Leaf) -Detail $installedExe
  Add-Check -Name "bundled-node" -Passed (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $installedExe) "resources\backend\node\node.exe") -PathType Leaf)
  Add-Check -Name "bundled-backend" -Passed (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $installedExe) "resources\backend\dist\cli.js") -PathType Leaf)

  if ($RequireSignature) {
    $installedSignature = Get-AuthenticodeSignature -LiteralPath $installedExe
    Add-Check -Name "installed-executable-signature" -Passed ($installedSignature.Status -eq "Valid") -Detail $installedSignature.Status
  }

  Push-Location $repositoryRoot
  try {
    & node scripts/certify-running-install.mjs verify $descriptorPath
    $automaticFirstRunExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  Add-Check -Name "installer-automatic-first-run-provider-catalog" -Passed ($automaticFirstRunExit -eq 0) -Detail "exit $automaticFirstRunExit"
  Add-Check -Name "first-run-creates-user-state" -Passed (Test-Path -LiteralPath $userState -PathType Container) -Detail $userState

  $installedDesktopProcesses = @(
    Get-CimInstance Win32_Process |
      Where-Object { $_.ExecutablePath -eq $installedExe }
  )
  Add-Check -Name "automatic-first-run-desktop-process" -Passed ($installedDesktopProcesses.Count -gt 0) -Detail $installedExe
  $installedDesktopProcesses |
    Sort-Object ProcessId -Descending |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Push-Location $repositoryRoot
  try {
    & node scripts/certify-running-install.mjs quit $descriptorPath
    $automaticFirstRunQuitExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  Add-Check -Name "automatic-first-run-cleanup" -Passed ($automaticFirstRunQuitExit -eq 0) -Detail "exit $automaticFirstRunQuitExit"

  $previousSelectedExecutable = $env:LUCKYTOKEN_PACKAGED_EXECUTABLE
  try {
    $env:LUCKYTOKEN_PACKAGED_EXECUTABLE = $installedExe
    Push-Location $repositoryRoot
    try {
      & node --test packages/desktop-shell/test/first-run-provider-catalog.e2e.test.mjs
      $firstRunExit = $LASTEXITCODE
    } finally {
      Pop-Location
    }
  } finally {
    if ($null -eq $previousSelectedExecutable) {
      Remove-Item Env:LUCKYTOKEN_PACKAGED_EXECUTABLE -ErrorAction SilentlyContinue
    } else {
      $env:LUCKYTOKEN_PACKAGED_EXECUTABLE = $previousSelectedExecutable
    }
  }
  Add-Check -Name "installed-blank-first-run-provider-catalog" -Passed ($firstRunExit -eq 0) -Detail "node --test exit $firstRunExit"
} finally {
  try {
    if (Test-Path -LiteralPath $updateExe -PathType Leaf) {
      $uninstallProcess = Start-Process -FilePath $updateExe -ArgumentList @("--uninstall", "-s") -PassThru -WindowStyle Hidden
      Wait-ReleaseProcess -Process $uninstallProcess -TimeoutMilliseconds 120000 -Label "Squirrel uninstaller"
      for ($attempt = 0; $attempt -lt 100 -and (Test-Path -LiteralPath $installedExe -PathType Leaf); $attempt += 1) {
        Start-Sleep -Milliseconds 100
      }
      Add-Check -Name "uninstall-removes-application" -Passed (-not (Test-Path -LiteralPath $installedExe -PathType Leaf))
    }
    $remainingInstalledProcesses = @(
      Get-CimInstance Win32_Process |
        Where-Object { $_.ExecutablePath -like "$installRoot\*" }
    )
    Add-Check -Name "uninstall-leaves-no-installed-process" -Passed ($remainingInstalledProcesses.Count -eq 0)
    Add-Check -Name "uninstall-preserves-user-state" -Passed (Test-Path -LiteralPath $userState)
  } finally {
    if ($null -eq $previousCodexHomeEnvironment) {
      Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    } else {
      $env:CODEX_HOME = $previousCodexHomeEnvironment
    }
    if (Test-Path -LiteralPath $testCodexHome -PathType Container) {
      Remove-Item -LiteralPath $testCodexHome -Recurse -Force
    }
  }
}

$evidence.finishedAt = [DateTimeOffset]::UtcNow.ToString("o")
$evidenceDirectory = Join-Path $repositoryRoot "artifacts\certification"
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
$evidencePath = Join-Path $evidenceDirectory ("windows-installer-{0}.json" -f [DateTimeOffset]::UtcNow.ToString("yyyyMMdd-HHmmss"))
$evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidencePath -Encoding utf8
Write-Host "Installer certification evidence: $evidencePath"
