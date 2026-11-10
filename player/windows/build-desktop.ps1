param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\artifacts\player-desktop-build'))
$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Compiler .NET Framework x64 belum tersedia pada mesin build.' }
Add-Type -AssemblyName System.Drawing
$logoPath = Join-Path $projectDirectory 'branding\RJ-Digital-Signage-System-logo-approved-v1.png'
$iconPath = Join-Path $outputPath 'RJPlayer.ico'
$sourceImage = [System.Drawing.Image]::FromFile($logoPath)
$iconBitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$ratio = [Math]::Min(256.0 / $sourceImage.Width, 256.0 / $sourceImage.Height)
$width = [int]($sourceImage.Width * $ratio)
$height = [int]($sourceImage.Height * $ratio)
$graphics.DrawImage($sourceImage, [int]((256 - $width) / 2), [int]((256 - $height) / 2), $width, $height)
$iconHandle = $iconBitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$iconStream = [System.IO.File]::Create($iconPath)
try { $icon.Save($iconStream) } finally { $iconStream.Dispose(); $icon.Dispose(); $graphics.Dispose(); $iconBitmap.Dispose(); $sourceImage.Dispose() }
# The process exits after compilation, releasing the temporary HICON allocated above.
$outputExecutable = Join-Path $outputPath 'RJ Player.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /utf8output ('/out:' + $outputExecutable) ('/win32icon:' + $iconPath) ('/win32manifest:' + (Join-Path $PSScriptRoot 'app.manifest')) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'RJPlayer.cs')
if ($LASTEXITCODE -ne 0) { throw 'Kompilasi RJ Player gagal.' }
Get-Item -LiteralPath $outputExecutable | Select-Object FullName, Length
