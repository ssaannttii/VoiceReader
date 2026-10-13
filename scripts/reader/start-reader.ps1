<#
.SYNOPSIS
  Start VoiceStudio + Reader on this PC and print the URL to open on your phone.

.DESCRIPTION
  1. Rebuilds the web UI (frontend/dist) when electron/src changed since the last build.
  2. Starts the backend on 127.0.0.1 (it also serves the web UI).
  3. Publishes it to your own devices:
       - Tailscale (default when Tailscale is running): `tailscale serve` -> works from anywhere
         your phone is on the tailnet. HTTPS when the tailnet has certificates enabled.
       - LAN (-Lan): the built-in network share with a PIN, for phones without Tailscale.
  Ctrl+C stops the backend. `tailscale serve` is reset on exit unless -KeepServe is given.

  -Background is the unattended mode used by the logon task (install-autostart.ps1): no
  console output (log in %APPDATA%\OmniVoice\reader-launcher.log), the backend is restarted
  if it exits, and `tailscale serve` stays on so the phone link keeps working.

.EXAMPLE
  .\scripts\reader\start-reader.ps1
  .\scripts\reader\start-reader.ps1 -Lan -NoTailscale
#>
param(
  [int]$Port = 3900,
  [switch]$Lan,
  [switch]$NoTailscale,
  [switch]$NoBuild,
  [switch]$KeepServe,
  [switch]$Background
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $Root
if ($Background) { $KeepServe = $true }

$logDir = Join-Path $env:APPDATA 'OmniVoice'
New-Item -ItemType Directory -Force $logDir | Out-Null
$launcherLog = Join-Path $logDir 'reader-launcher.log'

function Write-Step($msg) {
  if ($Background) { Add-Content $launcherLog ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg) }
  else { Write-Host "==> $msg" -ForegroundColor Cyan }
}

# uv / bun installed per-user may not be on PATH in a fresh shell.
foreach ($dir in @("$env:APPDATA\Python\Python314\Scripts", "$env:APPDATA\npm", "$env:USERPROFILE\.local\bin", "$env:USERPROFILE\.cargo\bin", "$env:ProgramFiles\Tailscale")) {
  if ((Test-Path $dir) -and ($env:PATH -notlike "*$dir*")) { $env:PATH = "$dir;$env:PATH" }
}
foreach ($tool in 'uv', 'bun') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found. See docs/reader/README.md (Setup)." }
}
if (-not (Test-Path '.venv\Scripts\python.exe')) { throw "Python env missing. Run: bun run setup:api" }

# ── 1. Web UI build ────────────────────────────────────────────────────────────
$dist = Join-Path $Root 'frontend\dist\index.html'
if (-not $NoBuild) {
  $stale = -not (Test-Path $dist)
  if (-not $stale) {
    $built = (Get-Item $dist).LastWriteTimeUtc
    $newer = Get-ChildItem 'electron\src', 'electron\public', 'electron\index.html' -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTimeUtc -gt $built } | Select-Object -First 1
    $stale = [bool]$newer
  }
  if ($stale) {
    Write-Step 'Building web UI (first run or sources changed)...'
    if ($Background) { bun run build:web *>> $launcherLog } else { bun run build:web }
    if ($LASTEXITCODE -ne 0) { throw 'Web UI build failed.' }
  }
}

# ── 2. Backend ─────────────────────────────────────────────────────────────────
$env:OMNIVOICE_PORT = "$Port"
$env:OMNIVOICE_BIND_HOST = '127.0.0.1'
$base = "http://127.0.0.1:$Port"

# Stable LAN PIN + port so a phone home-screen shortcut keeps working across restarts.
$pinFile = Join-Path $logDir 'reader-share-pin.txt'
if (-not (Test-Path $pinFile)) { [IO.File]::WriteAllText($pinFile, ('{0:D8}' -f (Get-Random -Minimum 10000000 -Maximum 99999999))) }
$env:OMNIVOICE_SHARE_PIN = ([IO.File]::ReadAllText($pinFile)).Trim()
if (-not $env:OMNIVOICE_SHARE_PORT) { $env:OMNIVOICE_SHARE_PORT = '3910' }
$backendLog = Join-Path $logDir 'reader-backend.log'

function Test-Backend { try { Invoke-RestMethod "$base/health" -TimeoutSec 2 | Out-Null; $true } catch { $false } }

function Start-Backend {
  Write-Step "Starting backend on $base ..."
  $p = Start-Process -FilePath 'uv' -ArgumentList @('run', '--no-sync', 'uvicorn', 'main:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', "$Port") `
    -RedirectStandardOutput $backendLog -RedirectStandardError "$backendLog.err" -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 240; $i++) {
    if ($p.HasExited) { throw "Backend exited during startup. Log: $backendLog.err" }
    if (Test-Backend) { return $p }
    Start-Sleep -Milliseconds 500
  }
  throw "Backend did not become ready. Log: $backendLog.err"
}

function Publish {
  $urls = @()
  if (-not $NoTailscale -and (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    $ts = Invoke-RestMethod "$base/system/tailscale/status"
    if ($ts.running) {
      Write-Step 'Publishing to your tailnet (tailscale serve)...'
      $r = Invoke-RestMethod -Method Post "$base/system/tailscale/enable"
      if ($r.ok) {
        $script:serveOn = $true
        $script:serveScheme = $r.scheme
        $urls += [pscustomobject]@{ Via = "Tailscale ($($r.scheme))"; Url = "$($r.url)/#/reader" }
        if ($r.scheme -ne 'https') {
          Write-Step 'Tip: enable "HTTPS Certificates" at https://login.tailscale.com/admin/dns to install Reader as an app.'
        }
      } else { Write-Step "Tailscale: $($r.error)" }
    } else { Write-Step 'Tailscale is installed but not running; skipping.' }
  }
  if ($Lan) {
    Write-Step 'Enabling LAN sharing...'
    $s = Invoke-RestMethod -Method Post "$base/system/network/enable"
    foreach ($ip in $s.lan_addresses) {
      $urls += [pscustomobject]@{ Via = "LAN (PIN $($s.pin))"; Url = "http://${ip}:$($s.share_port)/?pin=$($s.pin)#/reader" }
    }
  }
  # The phone links, for the user to find later without a console.
  $lines = @("This PC: $base/#/reader") + ($urls | ForEach-Object { "$($_.Via): $($_.Url)" })
  [IO.File]::WriteAllLines((Join-Path $logDir 'reader-links.txt'), $lines)
  $script:published = $true
  return $urls
}

# Switch the phone link to https:// as soon as the tailnet gets HTTPS certificates
# (needed to install Reader as an app); no restart required.
function Update-ServeScheme {
  if ($NoTailscale -or $script:serveScheme -eq 'https') { return }
  try {
    $st = Invoke-RestMethod "$base/system/tailscale/status" -TimeoutSec 15
    if ($st.running -and @($st.cert_domains).Count -gt 0) {
      Write-Step 'Tailscale HTTPS certificates are available; republishing over https.'
      Publish | Out-Null
    }
  } catch { }
}

$serveOn = $false
$serveScheme = $null
$published = $false
$proc = $null
try {
  if ($Background) {
    # Supervisor: keep a backend up (ours, or one the desktop app already runs), keep it
    # published, restart it when it stops, back off on repeated crashes. Health polling
    # instead of Wait-Process also covers a backend this script did not start.
    $delay = 5
    while ($true) {
      $started = $null
      if (-not (Test-Backend)) {
        try {
          $proc = Start-Backend
          $started = Get-Date
          Publish | Out-Null
        } catch {
          Write-Step "Error: $($_.Exception.Message)"
          $delay = [Math]::Min($delay * 2, 300)
          Start-Sleep -Seconds $delay
          continue
        }
      } elseif (-not $published) {
        try { Publish | Out-Null } catch { Write-Step "Publish failed: $($_.Exception.Message)" }
      }
      $misses = 0
      while ($misses -lt 3) {
        Start-Sleep -Seconds 20
        if (Test-Backend) { $misses = 0; Update-ServeScheme } else { $misses++ }
      }
      Write-Step 'Backend stopped responding; restarting.'
      if ($proc -and -not $proc.HasExited) { & taskkill /T /F /PID $proc.Id 2>$null | Out-Null }
      $published = $false
      $delay = if ($started -and ((Get-Date) - $started).TotalMinutes -gt 5) { 5 } else { [Math]::Min($delay * 2, 300) }
      Start-Sleep -Seconds $delay
    }
  }

  if (Test-Backend) { throw "Port $Port already serves a backend. Close VoiceStudio first or pass -Port." }
  $proc = Start-Backend
  $urls = Publish
  Write-Host ''
  Write-Host '  Reader is running.' -ForegroundColor Green
  Write-Host "  This PC:  $base/#/reader"
  foreach ($u in $urls) { Write-Host ("  {0,-22} {1}" -f "$($u.Via):", $u.Url) }
  Write-Host ''
  Write-Host '  Ctrl+C to stop.' -ForegroundColor DarkGray
  Wait-Process -Id $proc.Id
}
finally {
  if ($serveOn -and -not $KeepServe) {
    try { Invoke-RestMethod -Method Post "$base/system/tailscale/disable" -TimeoutSec 5 | Out-Null } catch { & tailscale serve reset 2>$null }
  }
  if ($proc -and -not $proc.HasExited) { & taskkill /T /F /PID $proc.Id 2>$null | Out-Null }
}
