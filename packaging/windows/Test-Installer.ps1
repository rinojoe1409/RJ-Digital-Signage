param([string]$Installer)
$ErrorActionPreference = 'Stop'
$rjProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $Installer) { $Installer = Join-Path $rjProject 'dist\windows-player\RJ-Digital-Signage-Player-Setup-0.3.2-x64.exe' }
$rjExtract = Join-Path $rjProject ('tmp\installer-extraction-' + [guid]::NewGuid().ToString('N'))
if (-not ([IO.Path]::GetFullPath($rjExtract).StartsWith($rjProject + '\', [StringComparison]::OrdinalIgnoreCase)) -or (Test-Path -LiteralPath $rjExtract)) { throw 'Folder QA tidak valid.' }
function Get-RjStartupValue {
    $rjKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
    if (-not $rjKey) { return $null }
    try { return $rjKey.GetValue('RJDigitalSignagePlayer', $null) } finally { $rjKey.Dispose() }
}
$rjBeforeStartup = Get-RjStartupValue
$rjUninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RJDigitalSignagePlayer'
$rjBeforeInstalled = Test-Path -LiteralPath $rjUninstallKey
$rjExtractProcess = Start-Process -FilePath $Installer -ArgumentList ('/S /EXTRACTONLY /D=' + $rjExtract) -WindowStyle Hidden -PassThru -Wait
if ($rjExtractProcess.ExitCode -ne 0) { throw ('Ekstraksi installer gagal: ' + $rjExtractProcess.ExitCode) }
$rjManifest = Get-Content -LiteralPath (Join-Path $rjExtract 'player-package.json') -Raw | ConvertFrom-Json
foreach ($rjFile in $rjManifest.files) {
    $rjFilePath = [IO.Path]::GetFullPath((Join-Path $rjExtract $rjFile.path))
    if (-not $rjFilePath.StartsWith($rjExtract + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path manifest keluar dari folder QA.' }
    if ((Get-FileHash -LiteralPath $rjFilePath -Algorithm SHA256).Hash -ine $rjFile.sha256) { throw ('Hash paket berbeda: ' + $rjFile.path) }
}
$rjFiles = @(Get-ChildItem -LiteralPath $rjExtract -Recurse -File)
if ($rjFiles.Count -ne ($rjManifest.files.Count + 1)) { throw 'Jumlah berkas paket tidak sesuai.' }
if ($rjFiles.Name -contains 'config.json' -or $rjFiles.Name -contains 'signage.sqlite') { throw 'Data pribadi ditemukan dalam paket.' }
if ([string]$rjBeforeStartup -cne [string](Get-RjStartupValue)) { throw 'Mode ekstraksi mengubah startup.' }
if ($rjBeforeInstalled -ne (Test-Path -LiteralPath $rjUninstallKey)) { throw 'Mode ekstraksi mendaftarkan aplikasi.' }
$rjExe = Join-Path $rjExtract 'RJ Player.exe'
$rjExeBytes = [IO.File]::ReadAllBytes($rjExe)
$rjPeOffset = [BitConverter]::ToInt32($rjExeBytes, 0x3c)
if ([BitConverter]::ToUInt16($rjExeBytes, $rjPeOffset + 4) -ne 0x8664) { throw 'Arsitektur launcher bukan x64.' }
$rjDiagnosticPath = Join-Path $rjProject 'artifacts\player-packaged-diagnostic.json'
$rjDiagnostic = Start-Process -FilePath $rjExe -ArgumentList @('--self-test', '--diagnostic-result', ('"' + $rjDiagnosticPath + '"')) -WindowStyle Hidden -Wait -PassThru
if ($rjDiagnostic.ExitCode -ne 0) { throw 'Diagnostik EXE hasil ekstraksi gagal.' }
if (-not (Get-Content -LiteralPath $rjDiagnosticPath -Raw | ConvertFrom-Json).ok) { throw 'Hasil diagnostik belum valid.' }
$rjResult = [ordered]@{ extracted = $rjExtract; files = $rjFiles.Count; manifestVerified = $true; privateDataExcluded = $true; startupUnchanged = $true; installedRegistryUnchanged = $true; launcherX64 = $true; packagedDiagnostic = $true }
[IO.File]::WriteAllText((Join-Path $rjProject 'artifacts\player-installer-extraction.json'), ($rjResult | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output ('EXTRACTED=' + $rjExtract)
Write-Output ('VERIFIED_FILES=' + $rjFiles.Count)
Write-Output 'STARTUP_AND_REGISTRATION_UNCHANGED=PASS'
Write-Output 'PACKAGED_EXE_DIAGNOSTIC=PASS'
