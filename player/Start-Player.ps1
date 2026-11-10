param([string]$DataDir = (Join-Path $PSScriptRoot 'data'), [string]$MediaDir, [switch]$Headless)
$ErrorActionPreference = 'Stop'
$portableNode = Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime\node.exe'
if (Test-Path -LiteralPath $portableNode) { $nodeExecutable = $portableNode }
else { $nodeExecutable = (Get-Command node -ErrorAction Stop).Source }
$nodeVersion = & $nodeExecutable -p 'process.versions.node.split(".")[0]'
if ([int]$nodeVersion -lt 24) { throw 'RJ Player membutuhkan Node.js 24 atau lebih baru.' }
$agentPath = Join-Path $PSScriptRoot 'agent.mjs'
if (-not $MediaDir) {
    if ($PSBoundParameters.ContainsKey('DataDir')) { $MediaDir = Join-Path $DataDir 'media' }
    else { $MediaDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Content RJ Digital' }
}
$arguments = @('"' + $agentPath + '"', '--data-dir', '"' + $DataDir + '"', '--media-dir', '"' + $MediaDir + '"')
if ($Headless) { $arguments += '--headless' }
# Hide only the background helper console. Edge kiosk opens its display window itself.
$process = Start-Process -FilePath $nodeExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
exit $process.ExitCode
