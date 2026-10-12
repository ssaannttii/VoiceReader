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

.EXAMPLE
  .\scripts\reader\start-reader.ps1
  .\scripts\reader\start-reader.ps1 -Lan -NoTailscale
#>
param(
  [int]$Port = 3900,
  [switch]$Lan,
  [switch]$NoTailscale,
  [switch]$NoBuild,
  [switch]$KeepServe
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $Root

# uv / bun installed per-user may not be on PATH in a fresh shell.
foreach ($dir in @("$env:APPDATA\Python\Python314\Scripts", "$env:APPDATA\npm", "$env:USERPROFILE\.local\bin", "$env:USERPROFILE\.cargo\bin")) {
  if ((Test-Path $dir) -and ($env:PATH -notlike "*$dir*")) { $env:PATH = "$dir;$env:PATH" }
}
foreach ($tool in 'uv', 'bun') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found. See docs/reader/README.md (Setup)." }
}
if (-not (Test-Path '.venv\Scripts\python.exe')) { throw "Python env missing. Run: bun run setup:api" }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

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
    bun run build:web
    if ($LASTEXITCODE -ne 0) { throw 'Web UI build failed.' }
  }
}

# ── 2. Backend ─────────────────────────────────────────────────────────────────
$env:OMNIVOICE_PORT = "$Port"
$env:OMNIVOICE_BIND_HOST = '127.0.0.1'
$base = "http://127.0.0.1:$Port"

# Stable LAN PIN + port so a phone home-screen shortcut keeps working across restarts.
$logDir = Join-Path $env:APPDATA 'OmniVoice'
New-Item -ItemType Directory -Force $logDir | Out-Null
$pinFile = Join-Path $logDir 'reader-share-pin.txt'
if (-not (Test-Path $pinFile)) { [IO.File]::WriteAllText($pinFile, ('{0:D8}' -f (Get-Random -Minimum 10000000 -Maximum 99999999))) }
$env:OMNIVOICE_SHARE_PIN = ([IO.File]::ReadAllText($pinFile)).Trim()
if (-not $env:OMNIVOICE_SHARE_PORT) { $env:OMNIVOICE_SHARE_PORT = '3910' }

try { Invoke-RestMethod "$base/health" -TimeoutSec 2 | Out-Null; throw "Port $Port already serves a backend. Close VoiceStudio first or pass -Port." }
catch [System.Net.WebException] { }

Write-Step "Starting backend on $base ..."
$backendLog = Join-Path $logDir 'reader-backend.log'
$proc = Start-Process -FilePath 'uv' -ArgumentList @('run', '--no-sync', 'uvicorn', 'main:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', "$Port") `
  -RedirectStandardOutput $backendLog -RedirectStandardError "$backendLog.err" -NoNewWindow -PassThru

$ready = $false
for ($i = 0; $i -lt 240; $i++) {
  if ($proc.HasExited) { Get-Content "$backendLog.err" -Tail 30; throw 'Backend exited during startup.' }
  try { Invoke-RestMethod "$base/health" -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) { throw "Backend did not become ready. Log: $backendLog.err" }

$urls = @()
$serveOn = $false
try {
  # ── 3a. Tailscale ────────────────────────────────────────────────────────────
  if (-not $NoTailscale -and (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    $ts = Invoke-RestMethod "$base/system/tailscale/status"
    if ($ts.running) {
      Write-Step 'Publishing to your tailnet (tailscale serve)...'
      $r = Invoke-RestMethod -Method Post "$base/system/tailscale/enable"
      if ($r.ok) {
        $serveOn = $true
        $urls += [pscustomobject]@{ Via = "Tailscale ($($r.scheme))"; Url = "$($r.url)/#/reader" }
        if ($r.scheme -ne 'https') {
          Write-Host '    Tip: enable "HTTPS Certificates" at https://login.tailscale.com/admin/dns' -ForegroundColor Yellow
          Write-Host '    to install Reader as a real app (PWA) with offline shell.' -ForegroundColor Yellow
        }
      } else { Write-Warning "Tailscale: $($r.error)" }
    } else { Write-Warning 'Tailscale is installed but not running; skipping.' }
  }

  # ── 3b. LAN share with PIN ───────────────────────────────────────────────────
  if ($Lan) {
    Write-Step 'Enabling LAN sharing...'
    $s = Invoke-RestMethod -Method Post "$base/system/network/enable"
    foreach ($ip in $s.lan_addresses) {
      $urls += [pscustomobject]@{ Via = "LAN (PIN $($s.pin))"; Url = "http://${ip}:$($s.share_port)/?pin=$($s.pin)#/reader" }
    }
  }

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
  if (-not $proc.HasExited) { & taskkill /T /F /PID $proc.Id 2>$null | Out-Null }
}
