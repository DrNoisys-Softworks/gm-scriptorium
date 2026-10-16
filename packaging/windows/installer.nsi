; GM-Scriptorium for Windows: the per-user installer and the uninstaller (ADR 0053).
;
; Built on Linux by scripts/installer.js, in two stages:
;   stage A  -DEXTRACT_UNINSTALLER   writes the uninstaller out (the `!uninstfinalize` line below
;                                    copies it to ${UNINSTALLER_OUT}); the installer this stage also
;                                    produces is thrown away.
;   stage B  (no EXTRACT define)     the real installer. It packs the signed exe and the signed
;                                    uninstaller uncompressed and has no uninstall section at all.
;
; Everything here runs as the signed-in user: RequestExecutionLevel user, HKCU only, no admin.
; Nothing in this file can be run on Linux; the pages and every message are checked on Windows
; (criteria C143 to C146 and C151 in .agents/windows-verification.md).

Unicode true

!ifndef VERSION
  !error "VERSION is required (scripts/installer.js passes it from package.json)"
!endif
!ifndef VERSION4
  !error "VERSION4 is required (the four-part number for the version resource)"
!endif
!ifndef OUTFILE
  !error "OUTFILE is required"
!endif
!ifdef EXTRACT_UNINSTALLER
  !ifndef UNINSTALLER_OUT
    !error "UNINSTALLER_OUT is required in the uninstaller stage"
  !endif
!else
  !ifndef EXE_IN
    !error "EXE_IN is required in the installer stage"
  !endif
  !ifndef UNINSTALLER_IN
    !error "UNINSTALLER_IN is required in the installer stage"
  !endif
  !ifndef NOTICES_IN
    !error "NOTICES_IN is required in the installer stage"
  !endif
  !ifndef TRAY_IN
    !error "TRAY_IN is required in the installer stage"
  !endif
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"

!ifdef EXTRACT_UNINSTALLER
  ${UnStrStr}
  !insertmacro un.GetParent
!endif

!define APP_NAME "GM-Scriptorium"
!define TRAY_WINDOW_CLASS "GMScriptoriumTray"
!define PUBLISHER "DrNoisys Softworks"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GM-Scriptorium"
!define FEEDBACK_URL "https://tally.so/r/eq19jQ"
!define ART_DIR "${__FILEDIR__}/art"

Name "${APP_NAME} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\GM-Scriptorium"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
BrandingText "${APP_NAME} ${VERSION}"
RequestExecutionLevel user
ManifestDPIAware true
SetCompress off
ShowInstDetails hide
ShowUninstDetails hide

VIProductVersion "${VERSION4}"
VIAddVersionKey /LANG=1033 "ProductName" "GM-Scriptorium"
VIAddVersionKey /LANG=1033 "CompanyName" "${PUBLISHER}"
!ifdef EXTRACT_UNINSTALLER
  VIAddVersionKey /LANG=1033 "FileDescription" "GM-Scriptorium Uninstall"
!else
  VIAddVersionKey /LANG=1033 "FileDescription" "GM-Scriptorium Setup"
!endif
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "${PUBLISHER}. MIT licence."

; ---------------------------------------------------------------------------------------------
; Look: the Lantern icon, a dark header strip and the brass side panel, as in the approved mock.
; The header strip is coloured by GmHeaderColors below, not by MUI_BGCOLOR, because that define would
; also paint the welcome and finish pages dark.
; ---------------------------------------------------------------------------------------------

!define MUI_ICON "${__FILEDIR__}/gm-scriptorium.ico"
!define MUI_UNICON "${__FILEDIR__}/gm-scriptorium.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${ART_DIR}/header.bmp"
!define MUI_HEADERIMAGE_BITMAP_STRETCH NoStretchNoCrop
!define MUI_HEADERIMAGE_UNBITMAP "${ART_DIR}/header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP_STRETCH NoStretchNoCrop
!define MUI_WELCOMEFINISHPAGE_BITMAP "${ART_DIR}/side.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${ART_DIR}/side.bmp"
!define MUI_ABORTWARNING
!define MUI_UNABORTWARNING

!ifdef WITH_PATH_OPTION
  !macro GmPathCommon UN
    ; Reads the user PATH, but only when it is safe to change. $gmPathState is 0 when the value is
    ; absent, 1 when $gmPathVal holds it whole and there is room to add this folder, 2 when it must
    ; be left alone (wrong type, would not fit, or read back truncated). $gmPathType is its type.
    Function ${UN}GmPathRead
      Push $0
      Push $1
      Push $2
      Push $3
      Push $4
      Push $5
      StrCpy $gmPathState 2
      StrCpy $gmPathVal ""
      System::Call 'advapi32::RegGetValueW(p 0x80000001, w "Environment", w "Path", i 0x1000ffff, *i .r1, p 0, *i .r2) i .r0'
      ; $0 error code, $1 type (1 = REG_SZ, 2 = REG_EXPAND_SZ), $2 size in bytes with the final NUL.
      ; 0x10000000 (RRF_NOEXPAND) keeps the type and the size those of the stored value.
      IntCmp $0 2 path_absent +1 path_unsafe
      IntCmp $0 0 +1 path_unsafe path_unsafe
      IntCmp $1 1 path_typed +1 +1
      IntCmp $1 2 path_typed path_unsafe path_unsafe
      path_typed:
        IntCmp $2 2 +1 path_unsafe +1
        IntOp $3 $2 / 2
        IntOp $3 $3 - 1
        StrLen $4 ";$INSTDIR"
        IntOp $4 $3 + $4
        IntOp $5 ${NSIS_MAX_STRLEN} - 1
        IntCmp $4 $5 path_unsafe +1 path_unsafe
        ReadRegStr $gmPathVal HKCU "Environment" "Path"
        StrLen $5 $gmPathVal
        IntCmp $5 $3 +1 path_unsafe path_unsafe
        StrCpy $gmPathType $1
        StrCpy $gmPathState 1
        Goto path_done
      path_absent:
        StrCpy $gmPathState 0
        Goto path_done
      path_unsafe:
        StrCpy $gmPathState 2
      path_done:
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd

    ; Splits $gmPathVal on ";". $gmPathNew is the same list without any component that is exactly
    ; $INSTDIR (case-insensitive), in the same order with every other entry kept as it was.
    ; $gmPathFound is 1 when at least one such component was there.
    Function ${UN}GmPathScan
      StrCpy $gmPathNew ""
      StrCpy $gmPathFound 0
      StrCpy $gmPathComp ""
      StrCpy $gmPathPos 0
      StrCpy $gmPathFirst 1
      scan_next:
        StrCpy $gmPathC $gmPathVal 1 $gmPathPos
        StrCmp $gmPathC ";" scan_emit
        StrCmp $gmPathC "" scan_emit
        StrCpy $gmPathComp "$gmPathComp$gmPathC"
        IntOp $gmPathPos $gmPathPos + 1
        Goto scan_next
      scan_emit:
        StrCmp $gmPathComp $INSTDIR scan_match
        StrCmp $gmPathFirst 1 scan_first
        StrCpy $gmPathNew "$gmPathNew;$gmPathComp"
        Goto scan_after
      scan_first:
        StrCpy $gmPathNew $gmPathComp
        StrCpy $gmPathFirst 0
        Goto scan_after
      scan_match:
        StrCpy $gmPathFound 1
      scan_after:
        StrCpy $gmPathComp ""
        StrCmp $gmPathC "" scan_done
        IntOp $gmPathPos $gmPathPos + 1
        Goto scan_next
      scan_done:
    FunctionEnd
  !macroend

  Var gmPathState
  Var gmPathType
  Var gmPathVal
  Var gmPathNew
  Var gmPathFound
  Var gmPathComp
  Var gmPathPos
  Var gmPathFirst
  Var gmPathC

!endif

!macro GmTrayCommon UN
  ; Closes a running tray app the way its own Quit does, then waits up to 5 seconds for its
  ; process to let go of gm-scriptorium-tray.exe, so the probe that follows does not see it exiting.
  Function ${UN}GmCloseTray
    Push $0
    Push $1
    Push $2
    FindWindow $0 "${TRAY_WINDOW_CLASS}"
    StrCmp $0 0 close_done
    SendMessage $0 ${WM_CLOSE} 0 0 /TIMEOUT=15000
    StrCpy $2 0
    close_wait:
      IfFileExists "$INSTDIR\gm-scriptorium-tray.exe" 0 close_done
      ClearErrors
      FileOpen $1 "$INSTDIR\gm-scriptorium-tray.exe" a
      IfErrors 0 close_free
      IntOp $2 $2 + 1
      IntCmp $2 20 close_done
      Sleep 250
      Goto close_wait
    close_free:
      FileClose $1
    close_done:
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
!macroend

Var gmChecksDone

!ifndef EXTRACT_UNINSTALLER

; ---------------------------------------------------------------------------------------------
; The installer (stage B)
; ---------------------------------------------------------------------------------------------

!include "${__FILEDIR__}/version.nsh"

!define MUI_CUSTOMFUNCTION_GUIINIT GmHeaderColors
Function GmHeaderColors
  SetCtlColors $mui.Header.Background "" 1B1916
  SetCtlColors $mui.Header.Text E8D7A8 1B1916
  SetCtlColors $mui.Header.SubText E8D7A8 1B1916
FunctionEnd

Var gmWho
Var gmHaveSettings
Var gmConfigPath
Var gmWantStart
Var gmWantDesktop
Var gmAutostart
Var gmPanelPort
Var gmPreviewPort
Var gmAdvOpen
Var gmCkStart
Var gmCkDesktop
Var gmCkAuto
Var gmHelpStart
Var gmHelpDesktop
Var gmHelpAuto
Var gmLblOff1
Var gmLblOff2
Var gmLblPanel
Var gmEdPanel
Var gmLblPreview
Var gmEdPreview
Var gmHelpPorts
!ifdef WITH_PATH_OPTION
  Var gmWantPath
  Var gmCkPath
  Var gmHelpPath
!endif

; Welcome
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APP_NAME} ${VERSION} Setup"
!define MUI_WELCOMEPAGE_TEXT "Setup will install ${APP_NAME} $gmWho. You don't need administrator permission.$\r$\n$\r$\n${APP_NAME} turns your gm-apprentice campaign vault into a website for your players. It runs quietly in the background on this PC, with an icon in the system tray, and nothing leaves it unless you publish.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME

; Where
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirLeave
!insertmacro MUI_PAGE_DIRECTORY

; Options: Setup's own page, so it can hold the port fields (ADR 0058). Every choice lives in a Var
; that hidden sections read, so a silent install gets the same defaults as the pages.
Page custom GmOptionsShow GmOptionsLeave

; Running copy: shown only when the tray app is running; Close and continue closes it.
Page custom GmRunningShow GmRunningLeave

; Existing settings: shown only when GmReadDefaults found a settings file. Setup never opens it.
Page custom GmSettingsShow

; Progress: the running-copy checks run just before it, so nothing is written first.
!define MUI_PAGE_CUSTOMFUNCTION_PRE GmInstallPre
!insertmacro MUI_PAGE_INSTFILES

; Finish: the box is ticked, and starts the tray app with no arguments.
!define MUI_FINISHPAGE_TITLE "Completing ${APP_NAME} Setup"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} is installed.$\r$\n$\r$\nIt lives in the system tray, by the clock. Closing your browser doesn't stop it; use the icon's Quit when you want it off.$\r$\n$\r$\nClick Finish to close Setup."
!define MUI_FINISHPAGE_RUN "$INSTDIR\gm-scriptorium-tray.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP_NAME} now"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

!insertmacro GmTrayCommon ""

!ifdef WITH_PATH_OPTION
  !insertmacro GmPathCommon ""

  ; Adds $INSTDIR to the user PATH, at the end, only behind the guard above. Never reorders, never
  ; writes HKLM, writes back the type it found. Records PathAdded only when it added the entry.
  Function GmPathAdd
    Call GmPathRead
    StrCmp $gmPathState 0 path_create
    StrCmp $gmPathState 1 path_present
    MessageBox MB_OK|MB_ICONINFORMATION "Setup didn't add ${APP_NAME} to your PATH, because your PATH list is too long to change safely. Nothing was changed.$\r$\n$\r$\n${APP_NAME} is installed and works as normal. To type gm-scriptorium in a terminal, add $INSTDIR to PATH yourself, or choose Open command line (Advanced) from its icon in the system tray." /SD IDOK
    Return

    path_create:
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
      Goto path_added

    path_present:
      Call GmPathScan
      StrCmp $gmPathFound 1 path_already
      StrLen $0 $gmPathVal
      StrCmp $0 0 path_only
      StrCpy $1 $gmPathVal 1 -1
      StrCmp $1 ";" path_join
      StrCpy $gmPathNew "$gmPathVal;$INSTDIR"
      Goto path_write
      path_join:
        StrCpy $gmPathNew "$gmPathVal$INSTDIR"
        Goto path_write
      path_only:
        StrCpy $gmPathNew "$INSTDIR"
      path_write:
        StrCmp $gmPathType 2 path_write_expand
        WriteRegStr HKCU "Environment" "Path" "$gmPathNew"
        Goto path_added
      path_write_expand:
        WriteRegExpandStr HKCU "Environment" "Path" "$gmPathNew"

    path_added:
      WriteRegDWORD HKCU "${UNINST_KEY}" "PathAdded" 1
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    path_already:
  FunctionEnd
!endif

; The write probe on leaving the folder page: create and delete one file, or say why not.
Function DirLeave
  ClearErrors
  CreateDirectory "$INSTDIR"
  FileOpen $0 "$INSTDIR\.gm-scriptorium-write-test" w
  IfErrors dir_not_writable
  FileClose $0
  Delete "$INSTDIR\.gm-scriptorium-write-test"
  Return
  dir_not_writable:
    MessageBox MB_OK|MB_ICONSTOP "Setup can't save files in $INSTDIR. Saving there needs administrator permission, and this Setup is just for you.$\r$\n$\r$\nPlease choose a folder inside your own user folder, such as $LOCALAPPDATA\Programs\GM-Scriptorium."
    Abort
FunctionEnd

; Runs before anything is written. Called just before the progress page and again at the top of the
; first section, so a silent install (no pages) gets the same checks; $gmChecksDone stops a second prompt.
;   1. A newer GM-Scriptorium is already here: OK/Cancel, Cancel is the default.
;   2. A copy is running: Retry/Cancel until the probe can open the exe for writing.
Function PreInstallChecks
  StrCmp $gmChecksDone 1 checks_return
  IfFileExists "$INSTDIR\gm-scriptorium.exe" 0 checks_ok

  nsExec::ExecToStack '"$INSTDIR\gm-scriptorium.exe" --version'
  Pop $0
  Pop $1
  StrCpy $gmVerInstalledText $1
  StrCpy $gmVerSetupText "${VERSION}"
  StrCmp $0 0 +1 version_unreadable
  Call GmVersionNeedsWarning
  StrCmp $gmVerWarn 1 version_warn probe_start
  version_unreadable:
    StrCpy $gmVerWarn 1
    StrCpy $gmVerInstalledText ""
  version_warn:
    StrCpy $2 $gmVerInstalledText
    StrCmp $2 "" version_warn_unknown
    ; Show only the first line of what the installed copy printed.
    StrCpy $3 0
    version_line:
      StrCpy $4 $2 1 $3
      StrCmp $4 "" version_line_done
      StrCmp $4 "$\r" version_line_done
      StrCmp $4 "$\n" version_line_done
      IntOp $3 $3 + 1
      Goto version_line
    version_line_done:
      StrCpy $2 $2 $3
    MessageBox MB_OKCANCEL|MB_DEFBUTTON2|MB_ICONEXCLAMATION "A newer version of ${APP_NAME} is already installed here ($2). This Setup would replace it with ${VERSION}, which is older.$\r$\n$\r$\nClick Cancel to keep the newer one. Click OK only if you really want to go back." /SD IDCANCEL IDOK probe_start
    Goto checks_cancelled
  version_warn_unknown:
    MessageBox MB_OKCANCEL|MB_DEFBUTTON2|MB_ICONEXCLAMATION "${APP_NAME} is already installed here, but Setup can't tell which version it is, so it may be newer than ${VERSION}.$\r$\n$\r$\nClick Cancel to keep it. Click OK only if you really want to replace it." /SD IDCANCEL IDOK probe_start
    Goto checks_cancelled

  probe_start:
    ClearErrors
    FileOpen $0 "$INSTDIR\gm-scriptorium.exe" a
    IfErrors probe_busy
    FileClose $0
    IfFileExists "$INSTDIR\gm-scriptorium-tray.exe" 0 checks_ok
    ClearErrors
    FileOpen $0 "$INSTDIR\gm-scriptorium-tray.exe" a
    IfErrors probe_busy
    FileClose $0
    Goto checks_ok
  probe_busy:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${APP_NAME} is open on this computer, so Setup can't replace it yet.$\r$\n$\r$\nClose the ${APP_NAME} window, then click Retry. Click Cancel to stop Setup without changing anything." /SD IDCANCEL IDRETRY probe_start
  checks_cancelled:
    SetErrorLevel 1
    Quit
  checks_ok:
    StrCpy $gmChecksDone 1
  checks_return:
FunctionEnd

Function GmInstallPre
  Call PreInstallChecks
FunctionEnd

; What the tray menu's Start with Windows tick would show (ADR 0057 section 7): the Run value
; exists and its StartupApproved value does not start with 0x03.
Function GmAutostartRead
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $gmAutostart 0
  ClearErrors
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GM-Scriptorium"
  IfErrors autostart_done
  StrCpy $gmAutostart 1
  System::Alloc 64
  Pop $2
  StrCmp $2 0 autostart_done
  System::Call 'advapi32::RegGetValueW(p 0x80000001, w "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run", w "GM-Scriptorium", i 0x1000ffff, p 0, p r2, *i 64 r4) i .r0'
  IntCmp $0 0 +1 autostart_free autostart_free
  IntCmp $4 1 +1 autostart_free +1
  System::Call '*$2(&i1 .r3)'
  IntCmp $3 3 +1 autostart_free autostart_free
  StrCpy $gmAutostart 0
  autostart_free:
  System::Free $2
  autostart_done:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Computes every choice's starting value, in .onInit so a silent install gets them too. The settings
; file is only looked for, never opened (ADR 0058 section 3).
Function GmReadDefaults
  Push $0
  ReadEnvStr $gmConfigPath SCRIPTORIUM_CONFIG
  StrCmp $gmConfigPath "" 0 +2
  StrCpy $gmConfigPath "$APPDATA\Scriptorium\config.toml"
  StrCpy $gmHaveSettings 0
  IfFileExists "$gmConfigPath" 0 +2
  StrCpy $gmHaveSettings 1

  StrCpy $gmPanelPort 7400
  StrCpy $gmPreviewPort 7401
  !ifdef WITH_PATH_OPTION
    StrCpy $gmWantPath 0
  !endif

  ; A shortcut box starts as the record Setup left says. With no record the Start menu box is ticked,
  ; and the Desktop box only when a shortcut of that name is already there.
  ClearErrors
  ReadRegDWORD $0 HKCU "${UNINST_KEY}" "StartMenuShortcut"
  IfErrors defaults_start_yes
  StrCmp $0 1 defaults_start_yes defaults_start_no
  defaults_start_yes:
    StrCpy $gmWantStart 1
    Goto defaults_start_done
  defaults_start_no:
    StrCpy $gmWantStart 0
  defaults_start_done:

  ClearErrors
  ReadRegDWORD $0 HKCU "${UNINST_KEY}" "DesktopShortcut"
  IfErrors defaults_desktop_new
  StrCmp $0 1 defaults_desktop_yes defaults_desktop_no
  defaults_desktop_new:
    IfFileExists "$DESKTOP\GM-Scriptorium.lnk" defaults_desktop_yes defaults_desktop_no
  defaults_desktop_yes:
    StrCpy $gmWantDesktop 1
    Goto defaults_desktop_done
  defaults_desktop_no:
    StrCpy $gmWantDesktop 0
  defaults_desktop_done:

  StrCmp $gmHaveSettings 1 defaults_auto_read
  StrCpy $gmAutostart 1
  Goto defaults_auto_done
  defaults_auto_read:
    Call GmAutostartRead
  defaults_auto_done:
  Pop $0
FunctionEnd

; Whether a port field holds a whole number from 1 to 65535: 1 to 5 digits, the first not 0 (NSIS
; reads a leading 0 as octal), checked before any number is made of it. Takes the text on the stack
; and leaves 1 (good) or 0 (refused).
Function GmPortValid
  Exch $0
  Push $1
  Push $2
  Push $3
  StrLen $1 $0
  IntCmp $1 1 +1 port_bad +1
  IntCmp $1 5 +1 +1 port_bad
  StrCpy $3 $0 1
  StrCmp $3 "0" port_bad
  StrCpy $2 0
  port_digit:
    StrCpy $3 $0 1 $2
    StrCmp $3 "0" port_next
    StrCmp $3 "1" port_next
    StrCmp $3 "2" port_next
    StrCmp $3 "3" port_next
    StrCmp $3 "4" port_next
    StrCmp $3 "5" port_next
    StrCmp $3 "6" port_next
    StrCmp $3 "7" port_next
    StrCmp $3 "8" port_next
    StrCmp $3 "9" port_next
    Goto port_bad
  port_next:
    IntOp $2 $2 + 1
    IntCmp $2 $1 port_digits_done port_digit
  port_digits_done:
  IntOp $3 $0 + 0
  IntCmp $3 65535 port_good port_good port_bad
  port_good:
    StrCpy $0 1
    Goto port_end
  port_bad:
    StrCpy $0 0
  port_end:
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

; Shows what the Advanced button and the three boxes call for: the help lines give way to the
; Advanced controls when it is open, and the "start it from its folder" line shows when all three
; boxes are off. There are two copies of that line so each view has its own place for it.
Function GmOptionsRefresh
  Push $0
  Push $1
  Push $2
  ${NSD_GetState} $gmCkStart $0
  ${NSD_GetState} $gmCkDesktop $1
  ${NSD_GetState} $gmCkAuto $2
  IntOp $0 $0 + $1
  IntOp $0 $0 + $2
  StrCmp $gmAdvOpen 1 refresh_open
  ShowWindow $gmHelpStart ${SW_SHOW}
  ShowWindow $gmHelpDesktop ${SW_SHOW}
  ShowWindow $gmHelpAuto ${SW_SHOW}
  ShowWindow $gmLblOff2 ${SW_HIDE}
  ShowWindow $gmLblPanel ${SW_HIDE}
  ShowWindow $gmEdPanel ${SW_HIDE}
  ShowWindow $gmLblPreview ${SW_HIDE}
  ShowWindow $gmEdPreview ${SW_HIDE}
  ShowWindow $gmHelpPorts ${SW_HIDE}
  !ifdef WITH_PATH_OPTION
    ShowWindow $gmCkPath ${SW_HIDE}
    ShowWindow $gmHelpPath ${SW_HIDE}
  !endif
  ShowWindow $gmLblOff1 ${SW_HIDE}
  StrCmp $0 0 0 refresh_done
  ShowWindow $gmLblOff1 ${SW_SHOW}
  Goto refresh_done
  refresh_open:
    ShowWindow $gmHelpStart ${SW_HIDE}
    ShowWindow $gmHelpDesktop ${SW_HIDE}
    ShowWindow $gmHelpAuto ${SW_HIDE}
    ShowWindow $gmLblOff1 ${SW_HIDE}
    ShowWindow $gmLblPanel ${SW_SHOW}
    ShowWindow $gmEdPanel ${SW_SHOW}
    ShowWindow $gmLblPreview ${SW_SHOW}
    ShowWindow $gmEdPreview ${SW_SHOW}
    ShowWindow $gmHelpPorts ${SW_SHOW}
    !ifdef WITH_PATH_OPTION
      ShowWindow $gmCkPath ${SW_SHOW}
      ShowWindow $gmHelpPath ${SW_SHOW}
    !endif
    ShowWindow $gmLblOff2 ${SW_HIDE}
    StrCmp $0 0 0 refresh_done
    ShowWindow $gmLblOff2 ${SW_SHOW}
  refresh_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The Advanced button, and the three boxes, call this; nsDialogs hands it the control's handle.
Function GmOptionsClicked
  Pop $0
  Call GmOptionsRefresh
FunctionEnd

Function GmAdvancedClicked
  Pop $0
  StrCmp $gmAdvOpen 1 advanced_close
  StrCpy $gmAdvOpen 1
  Goto advanced_apply
  advanced_close:
    StrCpy $gmAdvOpen 0
  advanced_apply:
  Call GmOptionsRefresh
FunctionEnd

Function GmOptionsShow
  !insertmacro MUI_HEADER_TEXT "Choose Options" "Pick what Setup adds for you."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  StrCpy $gmAdvOpen 0

  ${NSD_CreateCheckBox} 0 0 200u 10u "Start menu shortcut"
  Pop $gmCkStart
  ${NSD_CreateLabel} 12u 10u 240u 8u "Find ${APP_NAME} by typing its name in Start."
  Pop $gmHelpStart
  ${NSD_CreateCheckBox} 0 17u 100% 10u "Desktop shortcut"
  Pop $gmCkDesktop
  ${NSD_CreateLabel} 12u 27u 240u 8u "A shortcut on your desktop."
  Pop $gmHelpDesktop
  ${NSD_CreateCheckBox} 0 34u 100% 10u "Start ${APP_NAME} when I sign in to Windows"
  Pop $gmCkAuto
  ${NSD_CreateLabel} 12u 44u 240u 16u "It starts quietly in the system tray, with no window. Turn it off any time from its icon."
  Pop $gmHelpAuto
  ${NSD_CreateLabel} 0 62u 100% 16u "You'll need to start ${APP_NAME} from its folder: $INSTDIR"
  Pop $gmLblOff1
  ${NSD_CreateLabel} 0 44u 100% 16u "You'll need to start ${APP_NAME} from its folder: $INSTDIR"
  Pop $gmLblOff2

  !ifdef WITH_PATH_OPTION
    ${NSD_CreateCheckBox} 0 63u 100% 10u "Add ${APP_NAME} to PATH"
    Pop $gmCkPath
    ${NSD_CreateLabel} 12u 73u 252u 33u "Lets you type gm-scriptorium in any terminal window, not just the one its tray icon opens. It changes PATH for you only, and the uninstaller takes it out again. Leave it off unless you use the command line."
    Pop $gmHelpPath
  !endif

  ${NSD_CreateLabel} 0 110u 46u 10u "Panel port"
  Pop $gmLblPanel
  ${NSD_CreateNumber} 46u 108u 36u 12u "$gmPanelPort"
  Pop $gmEdPanel
  ${NSD_CreateLabel} 100u 110u 52u 10u "Preview port"
  Pop $gmLblPreview
  ${NSD_CreateNumber} 152u 108u 36u 12u "$gmPreviewPort"
  Pop $gmEdPreview
  ${NSD_Edit_SetTextLimit} $gmEdPanel 5
  ${NSD_Edit_SetTextLimit} $gmEdPreview 5
  StrCmp $gmHaveSettings 1 options_ports_locked
  ${NSD_CreateLabel} 12u 122u 252u 8u "Change these only if another program already uses them."
  Pop $gmHelpPorts
  Goto options_ports_made
  options_ports_locked:
    ${NSD_SetText} $gmEdPanel ""
    ${NSD_SetText} $gmEdPreview ""
    EnableWindow $gmEdPanel 0
    EnableWindow $gmEdPreview 0
    ${NSD_CreateLabel} 12u 122u 252u 16u "Setup found your settings, so it keeps the ports saved there. Change them later on the panel's Overview."
    Pop $gmHelpPorts
  options_ports_made:

  ${NSD_CreateButton} 206u 0 58u 13u "Advanced"
  Pop $0
  ${NSD_OnClick} $0 GmAdvancedClicked
  ${NSD_OnClick} $gmCkStart GmOptionsClicked
  ${NSD_OnClick} $gmCkDesktop GmOptionsClicked
  ${NSD_OnClick} $gmCkAuto GmOptionsClicked

  ${If} $gmWantStart == 1
    ${NSD_Check} $gmCkStart
  ${EndIf}
  ${If} $gmWantDesktop == 1
    ${NSD_Check} $gmCkDesktop
  ${EndIf}
  ${If} $gmAutostart == 1
    ${NSD_Check} $gmCkAuto
  ${EndIf}
  !ifdef WITH_PATH_OPTION
    ${If} $gmWantPath == 1
      ${NSD_Check} $gmCkPath
    ${EndIf}
  !endif
  Call GmOptionsRefresh

  ; With no settings and no running copy, this is the last page before the progress page.
  StrCmp $gmHaveSettings 0 0 options_next_done
  FindWindow $0 "${TRAY_WINDOW_CLASS}"
  StrCmp $0 0 0 options_next_done
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Install"
  options_next_done:
  nsDialogs::Show
FunctionEnd

; Keeps the choices, and refuses the ports before any command line is built from them.
Function GmOptionsLeave
  ${NSD_GetState} $gmCkStart $gmWantStart
  ${NSD_GetState} $gmCkDesktop $gmWantDesktop
  ${NSD_GetState} $gmCkAuto $gmAutostart
  !ifdef WITH_PATH_OPTION
    ${NSD_GetState} $gmCkPath $gmWantPath
  !endif
  StrCmp $gmHaveSettings 1 leave_done
  ${NSD_GetText} $gmEdPanel $0
  ${NSD_GetText} $gmEdPreview $1
  Push $0
  Call GmPortValid
  Pop $2
  Push $1
  Call GmPortValid
  Pop $3
  StrCmp $2 1 0 leave_refused
  StrCmp $3 1 0 leave_refused
  IntCmp $0 $1 leave_refused
  StrCpy $gmPanelPort $0
  StrCpy $gmPreviewPort $1
  Goto leave_done
  leave_refused:
    MessageBox MB_OK|MB_ICONEXCLAMATION "Type a number from 1 to 65535 for each port, and make the two different."
    Abort
  leave_done:
FunctionEnd

Function GmRunningShow
  FindWindow $0 "${TRAY_WINDOW_CLASS}"
  StrCmp $0 0 0 +2
  Abort
  !insertmacro MUI_HEADER_TEXT "${APP_NAME} is running" "Setup will close it."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "Everything you saved is on disk. If you tick $\"Start ${APP_NAME} now$\" at the end, it starts again."
  Pop $0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Close and continue"
  nsDialogs::Show
FunctionEnd

Function GmRunningLeave
  Call GmCloseTray
FunctionEnd

Function GmSettingsShow
  StrCmp $gmHaveSettings 1 +2
  Abort
  !insertmacro MUI_HEADER_TEXT "Your Campaigns" "Setup found your settings and won't change them."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 18u "Settings file: $gmConfigPath"
  Pop $0
  ${NSD_CreateLabel} 0 26u 100% 10u "To add another campaign, use Campaigns in the panel."
  Pop $0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Install"
  nsDialogs::Show
FunctionEnd

Function .onInit
  SetShellVarContext current
  StrCpy $gmChecksDone 0
  Call GmReadDefaults
  ReadEnvStr $0 USERNAME
  StrCmp $0 "" 0 who_named
  StrCpy $gmWho "for you only"
  Goto who_done
  who_named:
    StrCpy $gmWho "for you ($0) only"
  who_done:
FunctionEnd

; The program, always installed. The exe is written beside its final name and renamed into place, so
; the final name never holds a half-written exe.
Section "-Program files" SecMain
  SetShellVarContext current
  Call PreInstallChecks
  SetOutPath "$INSTDIR"

  File "/oname=gm-scriptorium.exe-setup.tmp" "${EXE_IN}"
  IfFileExists "$INSTDIR\gm-scriptorium.exe" 0 exe_rename
  ClearErrors
  Delete "$INSTDIR\gm-scriptorium.exe"
  IfFileExists "$INSTDIR\gm-scriptorium.exe" exe_stuck exe_rename
  exe_stuck:
    Delete "$INSTDIR\gm-scriptorium.exe-setup.tmp"
    MessageBox MB_OK|MB_ICONSTOP "Setup couldn't replace the existing ${APP_NAME}. Nothing was changed.$\r$\n$\r$\nClose ${APP_NAME} and run Setup again." /SD IDOK
    SetErrorLevel 2
    Abort
  exe_rename:
    ClearErrors
    Rename "$INSTDIR\gm-scriptorium.exe-setup.tmp" "$INSTDIR\gm-scriptorium.exe"
    IfErrors exe_rename_failed exe_renamed
  exe_rename_failed:
    Delete "$INSTDIR\gm-scriptorium.exe-setup.tmp"
    MessageBox MB_OK|MB_ICONSTOP "Setup couldn't finish saving ${APP_NAME}. Nothing was changed.$\r$\n$\r$\nRun Setup again." /SD IDOK
    SetErrorLevel 2
    Abort
  exe_renamed:

  ; The tray app is replaced the same way: beside its final name, then renamed into place.
  File "/oname=gm-scriptorium-tray.exe-setup.tmp" "${TRAY_IN}"
  IfFileExists "$INSTDIR\gm-scriptorium-tray.exe" 0 tray_rename
  ClearErrors
  Delete "$INSTDIR\gm-scriptorium-tray.exe"
  IfFileExists "$INSTDIR\gm-scriptorium-tray.exe" tray_stuck tray_rename
  tray_stuck:
    Delete "$INSTDIR\gm-scriptorium-tray.exe-setup.tmp"
    MessageBox MB_OK|MB_ICONSTOP "Setup couldn't save ${APP_NAME}'s tray app, so ${APP_NAME} may not start.$\r$\n$\r$\nQuit ${APP_NAME} if it is running, then run Setup again." /SD IDOK
    SetErrorLevel 2
    Abort
  tray_rename:
    ClearErrors
    Rename "$INSTDIR\gm-scriptorium-tray.exe-setup.tmp" "$INSTDIR\gm-scriptorium-tray.exe"
    IfErrors tray_rename_failed tray_renamed
  tray_rename_failed:
    Delete "$INSTDIR\gm-scriptorium-tray.exe-setup.tmp"
    MessageBox MB_OK|MB_ICONSTOP "Setup couldn't save ${APP_NAME}'s tray app, so ${APP_NAME} may not start.$\r$\n$\r$\nQuit ${APP_NAME} if it is running, then run Setup again." /SD IDOK
    SetErrorLevel 2
    Abort
  tray_renamed:

  File "/oname=THIRD-PARTY-NOTICES.txt" "${NOTICES_IN}"
  File "/oname=Uninstall GM-Scriptorium.exe" "${UNINSTALLER_IN}"

  SectionGetSize ${SecMain} $0
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "GM-Scriptorium"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall GM-Scriptorium.exe$\""
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\gm-scriptorium.exe,0"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

Section "-Shortcuts"
  SetShellVarContext current
  SetOutPath "$PROFILE"
  StrCmp $gmWantStart 1 shortcut_start_make
  Delete "$SMPROGRAMS\GM-Scriptorium.lnk"
  WriteRegDWORD HKCU "${UNINST_KEY}" "StartMenuShortcut" 0
  Goto shortcut_start_done
  shortcut_start_make:
    CreateShortCut "$SMPROGRAMS\GM-Scriptorium.lnk" "$INSTDIR\gm-scriptorium-tray.exe" "" "$INSTDIR\gm-scriptorium-tray.exe" 0
    WriteRegDWORD HKCU "${UNINST_KEY}" "StartMenuShortcut" 1
  shortcut_start_done:
  StrCmp $gmWantDesktop 1 shortcut_desktop_make
  Delete "$DESKTOP\GM-Scriptorium.lnk"
  WriteRegDWORD HKCU "${UNINST_KEY}" "DesktopShortcut" 0
  Goto shortcut_desktop_done
  shortcut_desktop_make:
    CreateShortCut "$DESKTOP\GM-Scriptorium.lnk" "$INSTDIR\gm-scriptorium-tray.exe" "" "$INSTDIR\gm-scriptorium-tray.exe" 0
    WriteRegDWORD HKCU "${UNINST_KEY}" "DesktopShortcut" 1
  shortcut_desktop_done:
SectionEnd

; Start with Windows goes through the tray app's own switch, so the tray app is its only writer. It
; runs only after the tray app is in place.
Section "-Start with Windows"
  SetShellVarContext current
  ClearErrors
  StrCmp $gmAutostart 1 autostart_on
  ExecWait '"$INSTDIR\gm-scriptorium-tray.exe" --autostart off' $0
  Goto autostart_ran
  autostart_on:
    ExecWait '"$INSTDIR\gm-scriptorium-tray.exe" --autostart on' $0
  autostart_ran:
  IfErrors autostart_failed
  StrCmp $0 0 autostart_done
  autostart_failed:
    DetailPrint "Start with Windows couldn't be changed. Use Start with Windows in the tray icon's menu."
  autostart_done:
SectionEnd

!ifdef WITH_PATH_OPTION
  Section "-PATH"
    SetShellVarContext current
    StrCmp $gmWantPath 1 0 +2
    Call GmPathAdd
  SectionEnd
!endif

; The ports go through the program's own `desktop set`, only when there are no settings yet and a
; port is not the default one. That makes the settings file; Setup never writes it itself.
Section "-Ports"
  SetShellVarContext current
  StrCmp $gmHaveSettings 0 0 ports_done
  StrCmp $gmPanelPort 7400 0 ports_set
  StrCmp $gmPreviewPort 7401 ports_done
  ports_set:
    nsExec::ExecToLog '"$INSTDIR\gm-scriptorium.exe" desktop set --port $gmPanelPort --preview-port $gmPreviewPort'
    Pop $0
    StrCmp $0 0 ports_done
    DetailPrint "The ports couldn't be saved, so the panel uses 7400 and 7401. Change them later on the panel's Overview."
  ports_done:
SectionEnd

; Leave the working folder away from the install folder, so the tray app the Finish box starts never
; has its current folder inside the one the uninstaller will remove.
Section "-Finish" SecFinish
  SetOutPath "$PROFILE"
SectionEnd

!else

; ---------------------------------------------------------------------------------------------
; The uninstaller (stage A)
; ---------------------------------------------------------------------------------------------

; Copies the uninstaller makensis builds to the path scripts/installer.js asked for.
!uninstfinalize 'cp "%1" "${UNINSTALLER_OUT}"'

Var gmKept
Var gmBold
Var gmFolderNote

!define MUI_CUSTOMFUNCTION_UNGUIINIT un.GmHeaderColors
Function un.GmHeaderColors
  SetCtlColors $mui.Header.Background "" 1B1916
  SetCtlColors $mui.Header.Text E8D7A8 1B1916
  SetCtlColors $mui.Header.SubText E8D7A8 1B1916
FunctionEnd

; Stage A's own installer exists only to make makensis write the uninstaller.
Section "-Write the uninstaller"
  WriteUninstaller "$INSTDIR\Uninstall GM-Scriptorium.exe"
SectionEnd

!insertmacro GmTrayCommon "un."

!ifdef WITH_PATH_OPTION
  !insertmacro GmPathCommon "un."

  ; Removes this install folder's own exact component from the user PATH, under the same guard the
  ; installer used. If the guard trips it leaves PATH alone and says so.
  Function un.GmPathRemove
    Call un.GmPathRead
    StrCmp $gmPathState 0 remove_done
    StrCmp $gmPathState 1 remove_scan
    MessageBox MB_OK|MB_ICONINFORMATION "Your PATH list is too long to change safely, so Setup's entry for ${APP_NAME} was left in it. It does no harm, and you can remove $INSTDIR from PATH yourself." /SD IDOK
    Goto remove_done
    remove_scan:
      Call un.GmPathScan
      StrCmp $gmPathFound 1 +1 remove_done
      StrCmp $gmPathNew "" remove_delete
      StrCmp $gmPathType 2 remove_expand
      WriteRegStr HKCU "Environment" "Path" "$gmPathNew"
      Goto remove_broadcast
      remove_expand:
        WriteRegExpandStr HKCU "Environment" "Path" "$gmPathNew"
        Goto remove_broadcast
      remove_delete:
        DeleteRegValue HKCU "Environment" "Path"
      remove_broadcast:
        SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    remove_done:
  FunctionEnd
!endif

; The same running-copy check as Setup: Retry until the exe can be opened for writing.
Function un.RunningCheck
  StrCmp $gmChecksDone 1 running_return
  IfFileExists "$INSTDIR\gm-scriptorium.exe" 0 running_ok
  running_probe:
    ClearErrors
    FileOpen $0 "$INSTDIR\gm-scriptorium.exe" a
    IfErrors running_busy
    FileClose $0
    IfFileExists "$INSTDIR\gm-scriptorium-tray.exe" 0 running_ok
    ClearErrors
    FileOpen $0 "$INSTDIR\gm-scriptorium-tray.exe" a
    IfErrors running_busy
    FileClose $0
    Goto running_ok
  running_busy:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${APP_NAME} is open on this computer, so it can't be removed yet.$\r$\n$\r$\nClose the ${APP_NAME} window, then click Retry. Click Cancel to stop without removing anything." /SD IDCANCEL IDRETRY running_probe
    SetErrorLevel 1
    Quit
  running_ok:
    StrCpy $gmChecksDone 1
  running_return:
FunctionEnd

; Confirm page: what goes, and what is never touched. Plain text, so no control can clip it.
Function un.ConfirmShow
  !insertmacro MUI_HEADER_TEXT "Uninstall ${APP_NAME}" "Remove ${APP_NAME} ${VERSION} from your computer."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  CreateFont $gmBold "$(^Font)" "$(^FontSize)" 700

  ; The first line is a reserved slot, used only when the tray app is running.
  FindWindow $1 "${TRAY_WINDOW_CLASS}"
  StrCmp $1 0 confirm_not_running
  ${NSD_CreateLabel} 0 0 100% 10u "${APP_NAME} is running. Uninstall will close it first."
  Pop $0
  confirm_not_running:
  ${NSD_CreateLabel} 0 11u 100% 18u "${APP_NAME} will be removed from$\r$\n$INSTDIR."
  Pop $0
  ${NSD_CreateLabel} 0 31u 100% 9u "Removed"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $gmBold 0
  ${NSD_CreateLabel} 8u 40u 100% 42u "The program, its tray helper, and any leftovers from updates$\r$\nThe Start menu and desktop shortcuts, if Setup made them$\r$\nThe start-with-Windows entry$\r$\nThe PATH entry, if Setup added one$\r$\nThe Installed apps entry"
  Pop $0
  ${NSD_CreateLabel} 0 85u 100% 9u "Never touched"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $gmBold 0
  ${NSD_CreateLabel} 8u 94u 100% 28u "Your settings and campaign list, in $APPDATA\Scriptorium$\r$\nYour campaign vaults, including their _meta\scriptorium\ folders$\r$\nYour built sites, and anything you have published"
  Pop $0

  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Uninstall"
  nsDialogs::Show
FunctionEnd

Function un.ConfirmLeave
  Call un.GmCloseTray
  Call un.RunningCheck
FunctionEnd

Function un.LaunchFeedback
  ExecShell "open" "${FEEDBACK_URL}"
FunctionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $gmChecksDone 0
  StrCpy $gmKept "$APPDATA\Scriptorium"
  ReadEnvStr $0 SCRIPTORIUM_CONFIG
  StrCmp $0 "" kept_done
  ${un.GetParent} "$0" $1
  StrCmp $1 "" kept_done
  StrCpy $gmKept "$gmKept and in $1 (named by SCRIPTORIUM_CONFIG)"
  kept_done:
FunctionEnd

UninstPage custom un.ConfirmShow un.ConfirmLeave
!insertmacro MUI_UNPAGE_INSTFILES

; Finish: what was kept, and an unticked box that opens the feedback form in the browser after
; Finish. The uninstaller itself sends nothing; the browser opens the page.
!define MUI_FINISHPAGE_TITLE "${APP_NAME} is removed"
!define MUI_FINISHPAGE_TEXT_LARGE
!define MUI_FINISHPAGE_TEXT "${APP_NAME} has been removed from your computer. It no longer starts when you sign in.$\r$\n$\r$\nKept, as always: your settings and campaign list in $gmKept, your campaign vaults and your built sites.$gmFolderNote"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION un.LaunchFeedback
!define MUI_FINISHPAGE_RUN_TEXT "Leave feedback for the developer. All feedback is read."
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; Named files only. The folder goes only if nothing else is in it. Settings are never touched.
Section Uninstall
  SetShellVarContext current
  Call un.GmCloseTray
  Call un.RunningCheck
  StrCpy $gmFolderNote ""

  Delete "$INSTDIR\gm-scriptorium.exe"
  Delete "$INSTDIR\gm-scriptorium.exe.old-*"
  Delete "$INSTDIR\gm-scriptorium.exe-update-*.tmp"
  Delete "$INSTDIR\gm-scriptorium.exe-setup.tmp"
  Delete "$INSTDIR\gm-scriptorium-tray.exe"
  Delete "$INSTDIR\gm-scriptorium-tray.exe.old-*"
  Delete "$INSTDIR\gm-scriptorium-tray.exe-update-*.tmp"
  Delete "$INSTDIR\gm-scriptorium-tray.exe-setup.tmp"

  ; THIRD-PARTY-NOTICES.txt goes only when its first 40 lines say it is Scriptorium's own: the title
  ; line, and a line that starts with the version stamp.
  StrCpy $2 0
  StrCpy $3 0
  StrCpy $4 0
  IfFileExists "$INSTDIR\THIRD-PARTY-NOTICES.txt" 0 notices_done
  ClearErrors
  FileOpen $0 "$INSTDIR\THIRD-PARTY-NOTICES.txt" r
  IfErrors notices_done
  notices_read:
    IntCmp $4 40 notices_close +1 +1
    FileRead $0 $1
    IfErrors notices_close
    IntOp $4 $4 + 1
    ${UnStrStr} $5 "$1" "Scriptorium: Third-Party Notices"
    StrCmp $5 "" +2
    StrCpy $2 1
    StrCpy $5 $1 21
    StrCmpS $5 "Scriptorium version: " 0 +2
    StrCpy $3 1
    Goto notices_read
  notices_close:
    FileClose $0
    StrCmp $2 1 0 notices_done
    StrCmp $3 1 0 notices_done
    Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
  notices_done:

  ; Each shortcut goes only when Setup recorded making it, so one the GM made by hand stays.
  ReadRegDWORD $0 HKCU "${UNINST_KEY}" "StartMenuShortcut"
  StrCmp $0 1 0 +2
  Delete "$SMPROGRAMS\GM-Scriptorium.lnk"
  ReadRegDWORD $0 HKCU "${UNINST_KEY}" "DesktopShortcut"
  StrCmp $0 1 0 +2
  Delete "$DESKTOP\GM-Scriptorium.lnk"

!ifdef WITH_PATH_OPTION
  ; Only when Setup added the entry, and then only its own exact component.
  ReadRegDWORD $0 HKCU "${UNINST_KEY}" "PathAdded"
  StrCmp $0 1 0 +2
  Call un.GmPathRemove
!endif

  ; What the tray app adds: its Start with Windows entry (and the switch Windows keeps for it) and
  ; its record of which notifications it has shown.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GM-Scriptorium"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "GM-Scriptorium"
  DeleteRegKey HKCU "Software\GM-Scriptorium"
  DeleteRegKey HKCU "${UNINST_KEY}"

  Delete "$INSTDIR\Uninstall GM-Scriptorium.exe"
  SetOutPath "$TEMP"
  ClearErrors
  RMDir "$INSTDIR"
  IfErrors 0 +2
  StrCpy $gmFolderNote "$\r$\n$\r$\nThe folder $INSTDIR was left in place because it holds files that are not ${APP_NAME}'s."
SectionEnd

!endif
