; Optix Attendance Server - Windows installer (built by scripts/build-windows.sh with makensis)
Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!ifndef VERSION
  !define VERSION "1.0.0"
!endif
Name "OKT Attendance Server ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Optix"
InstallDirRegKey HKLM "Software\Optix" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "OKT"
Icon "stage\okt.ico"
!define MUI_ABORTWARNING

Var HttpPort
Var HttpsPort
Var HttpsOn
Var DlgHttp
Var DlgHttps
Var DlgHttpsOn

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom PortsPage PortsLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open OKT in the browser"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenBrowser
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  StrCpy $HttpPort "8080"
  StrCpy $HttpsPort "8443"
  StrCpy $HttpsOn ${BST_UNCHECKED}
FunctionEnd

Function PortsPage
  !insertmacro MUI_HEADER_TEXT "Server ports" "Choose how the web service listens. You can change this later under System > Server Setting."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "HTTP is used by the devices and by browsers on your network. HTTPS (with a certificate Optix creates for you) is needed for the browser fingerprint and for phone GPS."
  Pop $0
  ${NSD_CreateLabel} 0 34u 90u 12u "HTTP port"
  Pop $0
  ${NSD_CreateNumber} 95u 32u 60u 12u "$HttpPort"
  Pop $DlgHttp
  ${NSD_CreateCheckbox} 0 58u 100% 12u "Also enable HTTPS"
  Pop $DlgHttpsOn
  ${NSD_SetState} $DlgHttpsOn $HttpsOn
  ${NSD_CreateLabel} 0 78u 90u 12u "HTTPS port"
  Pop $0
  ${NSD_CreateNumber} 95u 76u 60u 12u "$HttpsPort"
  Pop $DlgHttps
  nsDialogs::Show
FunctionEnd

Function PortsLeave
  ${NSD_GetText} $DlgHttp $HttpPort
  ${NSD_GetText} $DlgHttps $HttpsPort
  ${NSD_GetState} $DlgHttpsOn $HttpsOn
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

Function OpenBrowser
  ExecShell "open" "http://localhost:$HttpPort"
FunctionEnd

Section "Optix" SecMain
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
  CreateDirectory "$APPDATA\Optix"
  IfFileExists "$APPDATA\Optix\server.json" +8 0
    FileOpen $0 "$APPDATA\Optix\server.json" w
    ${If} $HttpsOn == ${BST_CHECKED}
      FileWrite $0 '{"http":{"enabled":true,"port":$HttpPort},"https":{"enabled":true,"port":$HttpsPort,"source":"auto","host":""},"redirect":false}'
    ${Else}
      FileWrite $0 '{"http":{"enabled":true,"port":$HttpPort},"https":{"enabled":false,"port":$HttpsPort,"source":"auto","host":""},"redirect":false}'
    ${EndIf}
    FileClose $0
  ; firewall: allow node.exe in, whatever ports you choose later in Server Setting
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Optix server"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Optix server" dir=in action=allow program="$INSTDIR\node.exe" enable=yes profile=any'
  ; start with Windows, restart if it stops
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-task.ps1" -InstallDir "$INSTDIR"'
  ; shortcuts
  CreateDirectory "$SMPROGRAMS\Optix"
  WriteINIStr "$SMPROGRAMS\Optix\Open OKT.url" "InternetShortcut" "URL" "http://localhost:$HttpPort"
  WriteINIStr "$SMPROGRAMS\Optix\Open OKT.url" "InternetShortcut" "IconFile" "$INSTDIR\okt.ico"
  WriteINIStr "$SMPROGRAMS\Optix\Open OKT.url" "InternetShortcut" "IconIndex" "0"
  CreateShortcut "$DESKTOP\OKT Attendance.lnk" "http://localhost:$HttpPort" "" "$INSTDIR\okt.ico" 0
  CreateShortcut "$SMPROGRAMS\Optix\Uninstall Optix.lnk" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Optix" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Optix" "DisplayName" "OKT Attendance Server"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Optix" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Optix" "Publisher" "OKT"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Optix" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Optix" "NoModify" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\remove-task.ps1"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Optix server"'
  RMDir /r "$SMPROGRAMS\Optix"
  Delete "$DESKTOP\OKT Attendance.lnk"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\install-task.ps1"
  Delete "$INSTDIR\remove-task.ps1"
  Delete "$INSTDIR\okt.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Optix"
  DeleteRegKey HKLM "Software\Optix"
  MessageBox MB_OK "Optix was removed. Your data (database, backups, settings) is kept in $APPDATA\Optix. Delete that folder if you do not need it."
SectionEnd
