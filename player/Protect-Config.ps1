param([string]$ConfigPath, [string]$DataDir)
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemIdentity = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if (-not $ConfigPath -and -not $DataDir) { throw 'Lokasi penyimpanan wajib diisi.' }
if ($DataDir) {
    $resolvedDirectory = [System.IO.Path]::GetFullPath($DataDir).TrimEnd('\')
    $unsafeDirectories = @([System.IO.Path]::GetPathRoot($resolvedDirectory).TrimEnd('\'), $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $PSScriptRoot, [System.IO.Directory]::GetParent($PSScriptRoot).FullName)
    if ($resolvedDirectory -in $unsafeDirectories) { throw 'Lokasi penyimpanan terlalu luas.' }
    if (-not [System.IO.Directory]::Exists($resolvedDirectory) -or ([System.IO.File]::GetAttributes($resolvedDirectory) -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Lokasi penyimpanan tidak valid.' }
    # Use .NET Framework ACL APIs directly: Node may inherit PSModulePath from PowerShell 7.
    $currentAcl = [System.IO.Directory]::GetAccessControl($resolvedDirectory)
    if ($currentAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw 'Folder penyimpanan harus dimiliki akun Windows yang menjalankan player.' }
    $directoryAcl = [System.Security.AccessControl.DirectorySecurity]::new()
    $directoryAcl.SetAccessRuleProtection($true, $false)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $directoryAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inheritance, 'None', 'Allow'))
    $directoryAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemIdentity, 'FullControl', $inheritance, 'None', 'Allow'))
    [System.IO.Directory]::SetAccessControl($resolvedDirectory, $directoryAcl)
}
if (-not $ConfigPath) { return }
$resolvedConfig = [System.IO.Path]::GetFullPath($ConfigPath)
if ($DataDir -and [System.IO.Path]::GetDirectoryName($resolvedConfig) -ne $resolvedDirectory) { throw 'Lokasi konfigurasi tidak sesuai penyimpanan.' }
if (-not [System.IO.File]::Exists($resolvedConfig) -or ([System.IO.File]::GetAttributes($resolvedConfig) -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Berkas konfigurasi tidak valid.' }
$fileAcl = [System.Security.AccessControl.FileSecurity]::new()
$fileAcl.SetAccessRuleProtection($true, $false)
$fileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
$fileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemIdentity, 'FullControl', 'Allow'))
[System.IO.File]::SetAccessControl($resolvedConfig, $fileAcl)
