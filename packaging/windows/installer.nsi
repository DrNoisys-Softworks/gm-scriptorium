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

; Welcome
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APP_NAME} ${VERSION} Setup"
!define MUI_WELCOMEPAGE_TEXT "Setup will install ${APP_NAME} $gmWho. You don't need administrator permission.$\r$\n$\r$\n${APP_NAME} turns your gm-apprentice campaign vault into a website for your players. It runs on this PC, and nothing leaves it unless you publish.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME

; Where
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirLeave
!insertmacro MUI_PAGE_DIRECTORY

; Options
!define MUI_PAGE_HEADER_TEXT "Choose Options"
!define MUI_PAGE_HEADER_SUBTEXT "Pick what Setup adds for you."
!define MUI_COMPONENTSPAGE_TEXT_TOP "Setup always adds a Start menu shortcut. Tick anything else you want."
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE OptionsLeave
!insertmacro MUI_PAGE_COMPONENTS

; Progress
!insertmacro MUI_PAGE_INSTFILES

; Finish: the box is ticked, and starts the exe with no arguments so it opens in launch mode.
!define MUI_FINISHPAGE_TITLE "Completing ${APP_NAME} Setup"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} is installed. Find it in the Start menu under G.$\r$\n$\r$\nClick Finish to close Setup."
!define MUI_FINISHPAGE_RUN "$INSTDIR\gm-scriptorium.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP_NAME} now"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

!ifdef WITH_PATH_OPTION
  !insertmacro GmPathCommon ""

  ; Adds $INSTDIR to the user PATH, at the end, only behind the guard above. Never reorders, never
  ; writes HKLM, writes back the type it found. Records PathAdded only when it added the entry.
  Function GmPathAdd
    Call GmPathRead
    StrCmp $gmPathState 0 path_create
    StrCmp $gmPathState 1 path_present
    MessageBox MB_OK|MB_ICONINFORMATION "Setup didn't add ${APP_NAME} to your PATH, because your PATH list is too long to change safely. Nothing was changed.$\r$\n$\r$\n${APP_NAME} is installed and works as normal. To type gm-scriptorium in a terminal, add $INSTDIR to PATH yourself, or use the Start menu shortcut." /SD IDOK
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

; Runs before anything is written. Called when Install is pressed and again at the top of the first
; section, so a silent install (no pages) gets the same checks; $gmChecksDone stops a second prompt.
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

Function OptionsLeave
  Call PreInstallChecks
FunctionEnd

Function .onInit
  SetShellVarContext current
  StrCpy $gmChecksDone 0
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

Section "Start menu shortcut" SecStart
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$PROFILE"
  CreateShortCut "$SMPROGRAMS\GM-Scriptorium.lnk" "$INSTDIR\gm-scriptorium.exe" "" "$INSTDIR\gm-scriptorium.exe" 0
SectionEnd

Section /o "Desktop shortcut" SecDesktop
  SetShellVarContext current
  SetOutPath "$PROFILE"
  CreateShortCut "$DESKTOP\GM-Scriptorium.lnk" "$INSTDIR\gm-scriptorium.exe" "" "$INSTDIR\gm-scriptorium.exe" 0
SectionEnd

!ifdef WITH_PATH_OPTION
  Section /o "Add GM-Scriptorium to PATH" SecPath
    SetShellVarContext current
    Call GmPathAdd
  SectionEnd
!endif

; Leave the working folder away from the install folder, so the exe the Finish box starts never has
; its current folder inside the one the uninstaller will remove.
Section "-Finish" SecFinish
  SetOutPath "$PROFILE"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStart} "Always added. Find ${APP_NAME} by typing its name in Start."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "A shortcut on your desktop."
  !ifdef WITH_PATH_OPTION
    !insertmacro MUI_DESCRIPTION_TEXT ${SecPath} "Lets you type gm-scriptorium in any terminal. Changes PATH for you only."
  !endif
!insertmacro MUI_FUNCTION_DESCRIPTION_END

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

  ${NSD_CreateLabel} 0 0 100% 20u "${APP_NAME} will be removed from$\r$\n$INSTDIR."
  Pop $0
  ${NSD_CreateLabel} 0 26u 100% 9u "Removed"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $gmBold 0
  ${NSD_CreateLabel} 8u 36u 100% 40u "The program, and any leftovers from updates$\r$\nThe Start menu shortcut, and the desktop shortcut if you made one$\r$\nThe PATH entry, if Setup added one$\r$\nThe Installed apps entry"
  Pop $0
  ${NSD_CreateLabel} 0 82u 100% 9u "Never touched"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $gmBold 0
  ${NSD_CreateLabel} 8u 92u 100% 32u "Your settings and campaign list, in $APPDATA\Scriptorium$\r$\nYour campaign vaults, including their _meta\scriptorium\ folders$\r$\nYour built sites, and anything you have published"
  Pop $0

  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Uninstall"
  nsDialogs::Show
FunctionEnd

Function un.ConfirmLeave
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
!define MUI_FINISHPAGE_TEXT "${APP_NAME} has been removed from your computer.$\r$\n$\r$\nKept, as always: your settings and campaign list in $gmKept, your campaign vaults and your built sites.$gmFolderNote"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION un.LaunchFeedback
!define MUI_FINISHPAGE_RUN_TEXT "Leave feedback for the developer. All feedback is read."
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; Named files only. The folder goes only if nothing else is in it. Settings are never touched.
Section Uninstall
  SetShellVarContext current
  Call un.RunningCheck
  StrCpy $gmFolderNote ""

  Delete "$INSTDIR\gm-scriptorium.exe"
  Delete "$INSTDIR\gm-scriptorium.exe.old-*"
  Delete "$INSTDIR\gm-scriptorium.exe-update-*.tmp"
  Delete "$INSTDIR\gm-scriptorium.exe-setup.tmp"

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

  Delete "$SMPROGRAMS\GM-Scriptorium.lnk"
  Delete "$DESKTOP\GM-Scriptorium.lnk"

!ifdef WITH_PATH_OPTION
  ; Only when Setup added the entry, and then only its own exact component.
  ReadRegDWORD $0 HKCU "${UNINST_KEY}" "PathAdded"
  StrCmp $0 1 0 +2
  Call un.GmPathRemove
!endif

  DeleteRegKey HKCU "${UNINST_KEY}"

  Delete "$INSTDIR\Uninstall GM-Scriptorium.exe"
  SetOutPath "$TEMP"
  ClearErrors
  RMDir "$INSTDIR"
  IfErrors 0 +2
  StrCpy $gmFolderNote "$\r$\n$\r$\nThe folder $INSTDIR was left in place because it holds files that are not ${APP_NAME}'s."
SectionEnd

!endif
