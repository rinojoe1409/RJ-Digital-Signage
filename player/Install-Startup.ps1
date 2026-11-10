param([string]$TaskName = 'RJ Digital Signage Player')
$ErrorActionPreference = 'Stop'
$startScript = Join-Path $PSScriptRoot 'Start-Player.ps1'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $startScript + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'RJ Player berjalan setelah pengguna Windows masuk; pulih otomatis bila proses berhenti.' -Force | Out-Null
Write-Output 'Autostart RJ Player terpasang untuk akun Windows saat ini. Berlaku setelah login.'
