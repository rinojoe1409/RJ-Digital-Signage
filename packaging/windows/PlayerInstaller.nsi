Unicode true
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma
CRCCheck force
SetOverwrite on
AllowSkipFiles off

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"

!ifndef RJ_PAYLOAD
  !error "RJ_PAYLOAD must point to the verified player payload"
!endif
!ifndef RJ_OUTPUT
  !error "RJ_OUTPUT must name the output installer"
!endif
!ifndef RJ_UNINSTALL_INCLUDE
  !error "RJ_UNINSTALL_INCLUDE must name the generated file list"
!endif
!define RJ_VERSION "0.3.2"
!define RJ_MARKER "RJ-PLAYER-1-4B79AECE-5493-44E3-A565-58D9D706C824"
!define RJ_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\RJDigitalSignagePlayer"
Name "RJ Digital Signage Player"
OutFile "${RJ_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\RJ Digital Signage Player"
BrandingText "Copyright ©2026 Rino Joe"
VIProductVersion "0.3.2.0"
VIAddVersionKey /LANG=1033 "ProductName" "RJ Digital Signage Player"
VIAddVersionKey /LANG=1033 "FileDescription" "Installer RJ Digital Signage Player untuk Windows x64"
VIAddVersionKey /LANG=1033 "FileVersion" "${RJ_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright ©2026 Rino Joe"
!define MUI_ICON "${RJ_PAYLOAD}\RJPlayer.ico"
!define MUI_UNICON "${RJ_PAYLOAD}\RJPlayer.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Pasang RJ Digital Signage Player"
!define MUI_WELCOMEPAGE_TEXT "Pemutar tayangan untuk PC Windows khusus signage.$\r$\n$\r$\nSetelah pemasangan, hubungkan player memakai alamat CMS dan kode pemasangan dari menu Player.$\r$\n$\r$\nOutput layar PC dapat digandakan ke TV melalui splitter."
!insertmacro MUI_PAGE_WELCOME
Page custom PlayerOptions PlayerOptionsLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "RJ Player berhasil dipasang"
!define MUI_FINISHPAGE_TEXT "Buka player, isi alamat CMS, nama player, dan kode pemasangan enam digit.$\r$\n$\r$\nAlamat CMS: http://IP-SERVER/ (ganti dengan IP server Linux)$\r$\n$\r$\nKonten yang telah tersimpan dapat diputar saat jaringan terputus."
!define MUI_FINISHPAGE_RUN "$INSTDIR\RJ Player.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Buka RJ Player sekarang"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Indonesian"

Var AutoStart
Var ExtractOnly
Var AutoStartCheckbox
Var Parameters
Var DefaultDirectory

Function .onInit
  SetShellVarContext current
  SetRegView 64
  StrCpy $ExtractOnly 0
  StrCpy $AutoStart 1
  StrCpy $DefaultDirectory "$LOCALAPPDATA\Programs\RJ Digital Signage Player"
  ${GetParameters} $Parameters
  ${GetOptions} $Parameters "/EXTRACTONLY" $0
  ${IfNot} ${Errors}
    StrCpy $ExtractOnly 1
    SetSilent silent
    ${If} $INSTDIR == $DefaultDirectory
      MessageBox MB_ICONSTOP "Mode ekstraksi memerlukan /D=folder-uji yang terpisah."
      SetErrorLevel 2
      Quit
    ${EndIf}
    IfFileExists "$INSTDIR\*" 0 extraction_ready
    SetErrorLevel 3
    Quit
extraction_ready:
    Return
  ${EndIf}
  ${GetOptions} $Parameters "/NOAUTOSTART" $0
  ${IfNot} ${Errors}
    StrCpy $AutoStart 0
  ${EndIf}
  StrCpy $INSTDIR $DefaultDirectory
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "RJ Player membutuhkan Windows 10 atau Windows 11 64-bit."
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Paket ini untuk Windows 64-bit."
    SetErrorLevel 2
    Quit
  ${EndIf}
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  ${If} ${Errors}
    Goto missing_framework
  ${EndIf}
  IntCmp $0 528040 framework_ok missing_framework framework_ok
missing_framework:
  MessageBox MB_ICONSTOP "Pasang .NET Framework 4.8 atau lebih baru melalui Windows Update/Microsoft, kemudian jalankan installer lagi."
  SetErrorLevel 2
  Quit
framework_ok:
  IfFileExists "$PROGRAMFILES64\Microsoft\Edge\Application\msedge.exe" edge_ok
  IfFileExists "$PROGRAMFILES32\Microsoft\Edge\Application\msedge.exe" edge_ok
  IfFileExists "$LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe" edge_ok
  MessageBox MB_ICONSTOP "Microsoft Edge belum ditemukan. Pasang Microsoft Edge pada PC ini terlebih dahulu, kemudian ulangi pemasangan."
  SetErrorLevel 2
  Quit
edge_ok:
  IfFileExists "$INSTDIR\rj-player.install-marker" existing_install
  IfFileExists "$INSTDIR\*" unsafe_install_directory init_done
existing_install:
  FileOpen $0 "$INSTDIR\rj-player.install-marker" r
  FileRead $0 $1
  FileClose $0
  ${If} $1 != "${RJ_MARKER}"
    Goto unsafe_install_directory
  ${EndIf}
  Goto init_done
unsafe_install_directory:
  MessageBox MB_ICONSTOP "Folder tujuan sudah berisi berkas yang bukan instalasi RJ Player ini. Periksa folder tersebut sebelum melanjutkan."
  SetErrorLevel 3
  Quit
init_done:
FunctionEnd

Function PlayerOptions
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Pilihan player" "Pemasangan berlaku untuk akun Windows yang sedang digunakan."
  ${NSD_CreateLabel} 0 0 100% 28u "Gunakan akun Windows yang nantinya masuk pada PC signage. Player menyala setelah akun tersebut login."
  Pop $0
  ${NSD_CreateCheckbox} 0 40u 100% 16u "Jalankan RJ Player otomatis setelah login Windows"
  Pop $AutoStartCheckbox
  ${If} $AutoStart == 1
    ${NSD_Check} $AutoStartCheckbox
  ${EndIf}
  ${NSD_CreateLabel} 0 70u 100% 42u "Shortcut player dan pengaturan akan tersedia pada menu Start. Data pairing serta cache disimpan terpisah dan dipertahankan saat aplikasi diperbarui."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function PlayerOptionsLeave
  ${NSD_GetState} $AutoStartCheckbox $AutoStart
FunctionEnd

Section "RJ Player"
  ${If} $ExtractOnly != 1
    IfFileExists "$INSTDIR\RJ Player.exe" 0 copy_payload
    ExecWait '"$INSTDIR\RJ Player.exe" --shutdown' $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "RJ Player belum dapat dihentikan. Tutup player melalui ikon di dekat jam Windows, lalu jalankan installer lagi."
      SetErrorLevel 3
      Abort
    ${EndIf}
    Sleep 500
  ${EndIf}
copy_payload:
  SetOutPath "$INSTDIR"
  File /r "${RJ_PAYLOAD}\*"
  ${If} $ExtractOnly == 1
    SetErrorLevel 0
    Return
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\RJ Digital Signage Player"
  CreateShortcut "$SMPROGRAMS\RJ Digital Signage Player\RJ Player.lnk" "$INSTDIR\RJ Player.exe"
  CreateShortcut "$SMPROGRAMS\RJ Digital Signage Player\Pengaturan Player.lnk" "$INSTDIR\RJ Player.exe" "--settings"
  CreateShortcut "$SMPROGRAMS\RJ Digital Signage Player\Hapus RJ Player.lnk" "$INSTDIR\Uninstall.exe"
  ${If} $AutoStart == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "RJDigitalSignagePlayer" '"$INSTDIR\RJ Player.exe" --autostart'
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "RJDigitalSignagePlayer"
  ${EndIf}
  WriteRegStr HKCU "${RJ_UNINSTALL_KEY}" "DisplayName" "RJ Digital Signage Player"
  WriteRegStr HKCU "${RJ_UNINSTALL_KEY}" "DisplayVersion" "${RJ_VERSION}"
  WriteRegStr HKCU "${RJ_UNINSTALL_KEY}" "Publisher" "Rino Joe"
  WriteRegStr HKCU "${RJ_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${RJ_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\RJ Player.exe"
  WriteRegStr HKCU "${RJ_UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${RJ_UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${RJ_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${RJ_UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  IfFileExists "$INSTDIR\rj-player.install-marker" 0 invalid_uninstall
  FileOpen $0 "$INSTDIR\rj-player.install-marker" r
  FileRead $0 $1
  FileClose $0
  ${If} $1 != "${RJ_MARKER}"
    Goto invalid_uninstall
  ${EndIf}
  ExecWait '"$INSTDIR\RJ Player.exe" --shutdown' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Tutup RJ Player melalui ikon di dekat jam Windows sebelum menghapus aplikasi."
    SetErrorLevel 3
    Quit
  ${EndIf}
  Sleep 500
  Return
invalid_uninstall:
  MessageBox MB_ICONSTOP "Folder aplikasi tidak sesuai. Penghapusan dibatalkan agar berkas lain tetap aman."
  SetErrorLevel 3
  Quit
FunctionEnd

Section "Uninstall"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "RJDigitalSignagePlayer"
  DeleteRegKey HKCU "${RJ_UNINSTALL_KEY}"
  Delete "$SMPROGRAMS\RJ Digital Signage Player\RJ Player.lnk"
  Delete "$SMPROGRAMS\RJ Digital Signage Player\Pengaturan Player.lnk"
  Delete "$SMPROGRAMS\RJ Digital Signage Player\Hapus RJ Player.lnk"
  RMDir "$SMPROGRAMS\RJ Digital Signage Player"
  !include "${RJ_UNINSTALL_INCLUDE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  # Pairing and cache are intentionally preserved outside the installed program directory.
SectionEnd
