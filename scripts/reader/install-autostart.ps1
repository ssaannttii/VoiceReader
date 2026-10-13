<#
.SYNOPSIS
  Start Reader automatically, hidden, every time you sign in to Windows.

.DESCRIPTION
  Registers a per-user scheduled task "VoiceReader" (no admin rights needed) that runs
  start-reader.ps1 -Background at logon. The launcher keeps the backend up and published to
  your tailnet, so the phone app always works while the PC is on.

  -Remove deletes the task and stops `tailscale serve`.
  -Lan also enables the PIN-protected LAN share.

.EXAMPLE
  .\scripts\reader\install-autostart.ps1
  .\scripts\reader\install-autostart.ps1 -Remove
#>
param([switch]$Remove, [switch]$Lan)

$ErrorActionPreference = 'Stop'
$TaskName = 'VoiceReader'
$launcher = Join-Path $PSScriptRoot 'start-reader.ps1'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

if ($Remove) {
  $c = Get-NetTCPConnection -LocalPort 3900 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { & taskkill /T /F /PID $c.OwningProcess 2>$null | Out-Null }
  if (Get-Command tailscale -ErrorAction SilentlyContinue) { & tailscale serve reset 2>$null }
  Write-Host 'Reader autostart removed.' -ForegroundColor Green
  return
}

# conhost --headless gives PowerShell a console with no window: nothing to close, no flash at
# sign-in, and no console control event can terminate the supervisor (it died with
# 0xC000013A when it owned a hidden window).
$taskArgs = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Background"
if ($Lan) { $taskArgs += ' -Lan' }
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $taskArgs -WorkingDirectory (Resolve-Path (Join-Path $PSScriptRoot '..\..'))
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Re-launch every 5 minutes as a watchdog; IgnoreNew makes it a no-op while the supervisor runs.
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Reader (VoiceReader): local text-to-speech reading app, published to your phone over Tailscale.' | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host 'Reader will now start automatically when you sign in. It is starting now.' -ForegroundColor Green
Write-Host "Phone link: see $env:APPDATA\OmniVoice\reader-links.txt in a minute."
