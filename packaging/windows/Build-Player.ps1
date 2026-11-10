param(
    [string]$NodeRuntimeDirectory,
    [string]$NsisExecutable,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$rjProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $NodeRuntimeDirectory) { $NodeRuntimeDirectory = Join-Path $rjProject 'build-tools\node-v24.22.2-win-x64' }
if (-not $NsisExecutable) { $NsisExecutable = Join-Path $rjProject 'build-tools\nsis-3.12\Bin\makensis.exe' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $rjProject 'dist\windows-player' }
$rjRuntime = [IO.Path]::GetFullPath($NodeRuntimeDirectory)
$rjCompiler = [IO.Path]::GetFullPath($NsisExecutable)
$rjOutput = [IO.Path]::GetFullPath($OutputDirectory)
$rjNode = Join-Path $rjRuntime 'node.exe'
foreach ($rjRequired in @($rjNode, (Join-Path $rjRuntime 'LICENSE'), $rjCompiler)) {
    if (-not (Test-Path -LiteralPath $rjRequired -PathType Leaf)) { throw ('Berkas build belum tersedia: ' + $rjRequired) }
}
$rjSignature = Get-AuthenticodeSignature -LiteralPath $rjNode
if ($rjSignature.Status -ne 'Valid' -or $rjSignature.SignerCertificate.Subject -notmatch 'OpenJS Foundation') { throw 'Runtime harus memakai Node resmi dengan tanda tangan OpenJS Foundation yang valid.' }
$rjNodeVersion = & $rjNode -p 'process.version'
if ($rjNodeVersion -notmatch '^v24\.') { throw 'Paket player membutuhkan runtime Node.js 24.' }
$rjApprovedLogo = Join-Path $rjProject 'branding\RJ-Digital-Signage-System-logo-approved-v1.png'
if ((Get-FileHash -LiteralPath $rjApprovedLogo -Algorithm SHA256).Hash -ine '5c167c93f838a8d909011a3ee69cc82091d2870b6afcba6d15a09a4a2d023945') { throw 'Logo resmi berubah; build dibatalkan.' }
$rjBuildId = Get-Date -Format 'yyyyMMdd-HHmmss'
$rjStage = Join-Path $rjProject ('build-tools\staging\player-0.3.2-' + $rjBuildId)
if (Test-Path -LiteralPath $rjStage) { throw 'Direktori staging sudah ada.' }
New-Item -ItemType Directory -Path $rjStage, $rjOutput -Force | Out-Null
& (Join-Path $rjProject 'player\windows\build-desktop.ps1') -OutputDirectory $rjStage
$rjFiles = @(
    'player\agent.mjs', 'player\content-cache.mjs', 'player\Protect-Config.ps1', 'player\Capture-Player.ps1',
    'public\player.html', 'public\player.js', 'public\player.css',
    'shared\renderer.mjs', 'shared\youtube.mjs', 'shared\program.mjs', 'shared\prayer.mjs',
    'branding\RJ-Digital-Signage-System-logo-approved-v1.png'
)
foreach ($rjRelative in $rjFiles) {
    $rjDestination = Join-Path $rjStage $rjRelative
    New-Item -ItemType Directory -Path (Split-Path $rjDestination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $rjProject $rjRelative) -Destination $rjDestination
}
New-Item -ItemType Directory -Path (Join-Path $rjStage 'runtime'), (Join-Path $rjStage 'licenses') -Force | Out-Null
Copy-Item -LiteralPath $rjNode -Destination (Join-Path $rjStage 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $rjRuntime 'LICENSE') -Destination (Join-Path $rjStage 'licenses\Node-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path (Split-Path (Split-Path $rjCompiler -Parent) -Parent) 'COPYING') -Destination (Join-Path $rjStage 'licenses\NSIS-COPYING.txt')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'PLAYER-INSTALLATION.md') -Destination (Join-Path $rjStage 'PLAYER-INSTALLATION.md')
$rjUtf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $rjStage 'rj-player.install-marker'), 'RJ-PLAYER-1-4B79AECE-5493-44E3-A565-58D9D706C824', $rjUtf8)
$rjManifestFiles = @(Get-ChildItem -LiteralPath $rjStage -Recurse -File | ForEach-Object {
    [ordered]@{ path = $_.FullName.Substring($rjStage.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); size = $_.Length }
})
$rjManifest = [ordered]@{ product = 'RJ Digital Signage Player'; version = '0.3.2'; architecture = 'x64'; node = $rjNodeVersion; builtAt = [DateTime]::UtcNow.ToString('o'); files = $rjManifestFiles }
[IO.File]::WriteAllText((Join-Path $rjStage 'player-package.json'), ($rjManifest | ConvertTo-Json -Depth 5), $rjUtf8)
$rjAllFiles = @(Get-ChildItem -LiteralPath $rjStage -Recurse -File)
$rjUninstallLines = @('# Generated from this payload. Delete only installed files; preserve unrelated files and user data.')
foreach ($rjFile in $rjAllFiles) {
    $rjRelative = $rjFile.FullName.Substring($rjStage.Length + 1)
    if ($rjRelative -notmatch '^[A-Za-z0-9 _.\\-]+$') { throw 'Nama berkas paket tidak aman untuk daftar uninstall.' }
    $rjUninstallLines += ('Delete "$INSTDIR\' + $rjRelative + '"')
}
$rjDirectories = @(Get-ChildItem -LiteralPath $rjStage -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending)
foreach ($rjDirectory in $rjDirectories) { $rjUninstallLines += ('RMDir "$INSTDIR\' + $rjDirectory.FullName.Substring($rjStage.Length + 1) + '"') }
# Each build gets its own generated include beside its uniquely named payload.
$rjUninstallInclude = Join-Path (Split-Path $rjStage -Parent) ('uninstall-' + $rjBuildId + '.nsh')
[IO.File]::WriteAllLines($rjUninstallInclude, $rjUninstallLines, $rjUtf8)
$rjInstaller = Join-Path $rjOutput 'RJ-Digital-Signage-Player-Setup-0.3.2-x64.exe'
$rjNsisDirectory = Split-Path (Split-Path $rjCompiler -Parent) -Parent
$rjPreviousNsisDirectory = $env:NSISDIR
try {
    $env:NSISDIR = $rjNsisDirectory
    & $rjCompiler /V3 /WX /INPUTCHARSET UTF8 ('/DRJ_PAYLOAD=' + $rjStage) ('/DRJ_OUTPUT=' + $rjInstaller) ('/DRJ_UNINSTALL_INCLUDE=' + $rjUninstallInclude) (Join-Path $PSScriptRoot 'PlayerInstaller.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'Pembuatan installer NSIS gagal.' }
} finally { $env:NSISDIR = $rjPreviousNsisDirectory }
$rjInstallerHash = (Get-FileHash -LiteralPath $rjInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($rjInstaller + '.sha256'), ($rjInstallerHash + '  ' + (Split-Path $rjInstaller -Leaf) + "`n"), $rjUtf8)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'PLAYER-INSTALLATION.md') -Destination (Join-Path $rjOutput 'CARA-INSTALL-PLAYER.md') -Force
[IO.File]::WriteAllText((Join-Path $rjOutput 'player-build.json'), ([ordered]@{ installer = (Split-Path $rjInstaller -Leaf); sha256 = $rjInstallerHash; payload = $rjStage; version = '0.3.2'; runtime = $rjNodeVersion; installerBytes = (Get-Item -LiteralPath $rjInstaller).Length; files = $rjAllFiles.Count } | ConvertTo-Json), $rjUtf8)
Write-Output ('INSTALLER=' + $rjInstaller)
Write-Output ('SHA256=' + $rjInstallerHash)
Write-Output ('PAYLOAD=' + $rjStage)
