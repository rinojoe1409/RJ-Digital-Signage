param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path $PSScriptRoot -Parent
$candidatePaths = @(
    (Join-Path $projectDirectory 'runtime\node.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
)
$installedNode = Get-Command node -ErrorAction SilentlyContinue
if ($installedNode) { $candidatePaths += $installedNode.Source }
$nodeExecutable = $null
foreach ($candidatePath in $candidatePaths) {
    if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
        $major = & $candidatePath -p 'process.versions.node.split(".")[0]'
        if ([int]$major -eq 24) { $nodeExecutable = $candidatePath; break }
    }
}
if (-not $nodeExecutable) { throw 'Pasang Node.js 24 agar server lokal dapat dijalankan.' }
$serverPath = Join-Path $projectDirectory 'server\server.mjs'
if ($Foreground) {
    Push-Location $projectDirectory
    try { & $nodeExecutable $serverPath } finally { Pop-Location }
} else {
    $serverData = Join-Path $projectDirectory 'data'
    New-Item -ItemType Directory -Path $serverData -Force | Out-Null
    $running = Get-NetTCPConnection -State Listen -LocalPort 3210 -ErrorAction SilentlyContinue
    if ($running) { Write-Output 'Port 3210 sudah digunakan. Buka http://localhost:3210 dan periksa aplikasi yang berjalan.'; exit 0 }
    $started = Start-Process -FilePath $nodeExecutable -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $serverData 'server.log') -RedirectStandardError (Join-Path $serverData 'server-error.log')
    Set-Content -LiteralPath (Join-Path $serverData 'server.pid') -Value $started.Id
    Write-Output 'RJ Digital Signage System dijalankan. Buka http://localhost:3210.'
}
