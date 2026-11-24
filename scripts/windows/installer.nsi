; ZKT Attendance Server - Windows installer (built by scripts/build-windows.sh with makensis)
Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!ifndef VERSION
  !define VERSION "1.0.0"
!endif
Name "ZKT Attendance Server ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\ZKT"
InstallDirRegKey HKLM "Software\OKT" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "ZKT"
Icon "stage\okt.ico"
!define MUI_ABORTWARNING

Var HttpPort
Var HttpsPort
Var HttpsOn
Var DlgHttp
Var DlgHttps
Var DlgHttpsOn
Var BackupDir
Var DlgBackup
Var DlgBrowse
Var AddFirewall
Var DlgFirewall

Page custom StartPage
Page custom OverviewPage
!insertmacro MUI_PAGE_DIRECTORY
Page custom PortsPage PortsLeave
Page custom DatabasePage
Page custom BackupPage BackupLeave
Page custom ReadyPage
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open ZKT in the browser"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenBrowser
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext all
  StrCpy $HttpPort "8888"
  StrCpy $HttpsPort "8443"
  StrCpy $HttpsOn ${BST_UNCHECKED}
  StrCpy $AddFirewall ${BST_CHECKED}
  StrCpy $BackupDir "$APPDATA\OKT\backups"
  IfFileExists "$APPDATA\OKT\backup-path.txt" 0 backupInitDone
    FileOpen $0 "$APPDATA\OKT\backup-path.txt" r
    FileRead $0 $1
    FileClose $0
    ${If} $1 != ""
      StrCpy $BackupDir $1
    ${EndIf}
  backupInitDone:
FunctionEnd

Function StartPage
  !insertmacro MUI_HEADER_TEXT "ZKT Attendance" "Welcome to the setup wizard"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 20u 20u 92% 30u "ZKT Attendance Server"
  Pop $0
  ${NSD_CreateLabel} 20u 56u 92% 44u "Install the web-based attendance server, connect time clocks and manage employee attendance in your browser."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function OverviewPage
  !insertmacro MUI_HEADER_TEXT "Before you install" "The setup keeps existing data when you upgrade"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 12u 12u 95% 24u "The server runs locally on this PC and starts with Windows."
  Pop $0
  ${NSD_CreateLabel} 12u 42u 95% 35u "Next choose the installation folder, service port, firewall access and backup folder. Your existing employees, devices and attendance records stay in the data folder."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function PortsPage
  !insertmacro MUI_HEADER_TEXT "Service port and firewall" "Choose how time clocks and browsers connect"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "HTTP is used by devices and browsers. Existing server settings are preserved during an upgrade."
  Pop $0
  ${NSD_CreateLabel} 0 34u 90u 12u "HTTP port"
  Pop $0
  ${NSD_CreateNumber} 95u 32u 60u 12u "$HttpPort"
  Pop $DlgHttp
  ${NSD_CreateCheckbox} 0 54u 100% 12u "Add Windows Firewall exception"
  Pop $DlgFirewall
  ${NSD_SetState} $DlgFirewall $AddFirewall
  ${NSD_CreateCheckbox} 0 73u 100% 12u "Also enable HTTPS"
  Pop $DlgHttpsOn
  ${NSD_SetState} $DlgHttpsOn $HttpsOn
  ${NSD_CreateLabel} 0 97u 90u 12u "HTTPS port"
  Pop $0
  ${NSD_CreateNumber} 95u 95u 60u 12u "$HttpsPort"
  Pop $DlgHttps
  nsDialogs::Show
FunctionEnd

Function PortsLeave
  ${NSD_GetText} $DlgHttp $HttpPort
  ${NSD_GetText} $DlgHttps $HttpsPort
  ${NSD_GetState} $DlgHttpsOn $HttpsOn
  ${NSD_GetState} $DlgFirewall $AddFirewall
  ${If} $HttpPort < 1
  ${OrIf} $HttpPort > 65535
    MessageBox MB_ICONEXCLAMATION "The HTTP port must be a number from 1 to 65535."
    Abort
  ${EndIf}
  ${If} $HttpsOn == ${BST_CHECKED}
    ${If} $HttpsPort < 1
    ${OrIf} $HttpsPort > 65535
      MessageBox MB_ICONEXCLAMATION "The HTTPS port must be a number from 1 to 65535."
      Abort
    ${EndIf}
    ${If} $HttpsPort == $HttpPort
      MessageBox MB_ICONEXCLAMATION "HTTP and HTTPS need different ports."
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function DatabasePage
  !insertmacro MUI_HEADER_TEXT "Database" "Your data is configured automatically"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 12u 15u 95% 24u "SQLite database (included)"
  Pop $0
  ${NSD_CreateLabel} 12u 46u 95% 52u "No database username or password is needed. The database is stored separately from the program, so installing a newer version keeps employee, device and attendance data."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function BackupPage
  !insertmacro MUI_HEADER_TEXT "Database backup path" "Choose where automatic database backups are saved"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 12u 100% 24u "Daily backups are stored in the folder below. Existing backup settings are preserved during upgrades."
  Pop $0
  ${NSD_CreateText} 0 52u 73% 13u "$BackupDir"
  Pop $DlgBackup
  ${NSD_CreateButton} 77% 51u 23% 15u "Browse..."
  Pop $DlgBrowse
  ${NSD_OnClick} $DlgBrowse BrowseBackup
  nsDialogs::Show
FunctionEnd

Function BrowseBackup
  nsDialogs::SelectFolderDialog "Choose backup folder" "$BackupDir"
  Pop $0
  ${If} $0 != "error"
    StrCpy $BackupDir $0
    ${NSD_SetText} $DlgBackup $BackupDir
  ${EndIf}
FunctionEnd

Function BackupLeave
  ${NSD_GetText} $DlgBackup $BackupDir
  ${If} $BackupDir == ""
    MessageBox MB_ICONEXCLAMATION "Choose a backup folder."
    Abort
  ${EndIf}
FunctionEnd

Function ReadyPage
  !insertmacro MUI_HEADER_TEXT "Ready to install" "Review your settings, then select Install"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 10u 100% 22u "Program folder: $INSTDIR"
  Pop $0
  ${NSD_CreateLabel} 0 38u 100% 22u "HTTP service port: $HttpPort"
  Pop $0
  ${NSD_CreateLabel} 0 66u 100% 22u "Database: SQLite (included)"
  Pop $0
  ${NSD_CreateLabel} 0 94u 100% 22u "Backup folder: $BackupDir"
  Pop $0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 0x000C 0 "STR:Install"
  nsDialogs::Show
FunctionEnd

Function OpenBrowser
  ExecShell "open" "http://localhost:$HttpPort"
FunctionEnd

Section "ZKT" SecMain
  SetShellVarContext all
  ; stop an older copy first (upgrade)
  InitPluginsDir
  File "/oname=$PLUGINSDIR\remove-task.ps1" "stage\remove-task.ps1"
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\remove-task.ps1"'
  SetOutPath "$INSTDIR"
  File "stage\node.exe"
  File "stage\install-task.ps1"
  File "stage\remove-task.ps1"
  File "stage\okt.ico"
  SetOutPath "$INSTDIR\app"
  File /r "stage\app\*.*"
  ; settings and data live in ProgramData so an upgrade or uninstall never touches them
  CreateDirectory "$APPDATA\OKT"
  IfFileExists "$APPDATA\OKT\server.json" settingsDone 0
    FileOpen $0 "$APPDATA\OKT\server.json" w
    ${If} $HttpsOn == ${BST_CHECKED}
      FileWrite $0 '{"http":{"enabled":true,"port":$HttpPort},"https":{"enabled":true,"port":$HttpsPort,"source":"auto","host":""},"redirect":false}'
    ${Else}
      FileWrite $0 '{"http":{"enabled":true,"port":$HttpPort},"https":{"enabled":false,"port":$HttpsPort,"source":"auto","host":""},"redirect":false}'
    ${EndIf}
    FileClose $0
  settingsDone:
  CreateDirectory "$BackupDir"
  FileOpen $0 "$APPDATA\OKT\backup-path.txt" w
  FileWrite $0 "$BackupDir"
  FileClose $0
  ; firewall: allow node.exe in, whatever ports you choose later in Server Setting
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="OKT server"'
  ${If} $AddFirewall == ${BST_CHECKED}
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="OKT server" dir=in action=allow program="$INSTDIR\node.exe" enable=yes profile=any'
  ${EndIf}
  ; start with Windows, restart if it stops
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-task.ps1" -InstallDir "$INSTDIR"'
  ; shortcuts
  Delete "$DESKTOP\OKT Attendance.lnk"
  RMDir /r "$SMPROGRAMS\OKT"
  CreateDirectory "$SMPROGRAMS\ZKT"
  WriteINIStr "$SMPROGRAMS\ZKT\Open ZKT.url" "InternetShortcut" "URL" "http://localhost:$HttpPort"
  WriteINIStr "$SMPROGRAMS\ZKT\Open ZKT.url" "InternetShortcut" "IconFile" "$INSTDIR\okt.ico"
  WriteINIStr "$SMPROGRAMS\ZKT\Open ZKT.url" "InternetShortcut" "IconIndex" "0"
  CreateShortcut "$DESKTOP\ZKT Attendance.lnk" "http://localhost:$HttpPort" "" "$INSTDIR\okt.ico" 0
  CreateShortcut "$SMPROGRAMS\ZKT\Uninstall ZKT.lnk" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\OKT" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OKT" "DisplayName" "ZKT Attendance Server"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OKT" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OKT" "Publisher" "Optix"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OKT" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OKT" "NoModify" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\remove-task.ps1"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="OKT server"'
  RMDir /r "$SMPROGRAMS\ZKT"
  RMDir /r "$SMPROGRAMS\OKT"
  Delete "$DESKTOP\ZKT Attendance.lnk"
  Delete "$DESKTOP\OKT Attendance.lnk"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\install-task.ps1"
  Delete "$INSTDIR\remove-task.ps1"
  Delete "$INSTDIR\okt.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OKT"
  DeleteRegKey HKLM "Software\OKT"
  MessageBox MB_OK "ZKT was removed. Your data (database, backups, settings) is kept in $APPDATA\OKT. Delete that folder if you do not need it."
SectionEnd
