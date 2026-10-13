; The install-time version compare (ADR 0053, "The newer-version warning").
;
; Pure string work: no registry, no files, no processes. The installer runs the installed exe with
; --version, takes the first line, and asks GmVersionNeedsWarning whether Setup is about to put an
; older program over a newer one.
;
; The grammar is the one scripts/installer.js enforces on the version it is built with:
;   X.Y.Z            or            X.Y.Z-rc.N
; numerics only, one to nine digits each. Anything else (a build tag, a "-beta", a missing part, text
; after the version on the same line) does not parse. A stable release beats an rc of the same X.Y.Z.
;
; Inputs  : $gmVerInstalledText, $gmVerSetupText
; Output  : $gmVerWarn = 1 when the caller must show the Cancel-by-default box (installed is newer,
;           or installed does not parse, or Setup's own version does not parse), else 0.
; Clobbers: the gmVer* variables below. Nothing else.

!ifndef GM_VERSION_NSH
!define GM_VERSION_NSH

Var gmVerInstalledText
Var gmVerSetupText
Var gmVerWarn

; Parse input and results.
Var gmVerIn
Var gmVerOk
Var gmVerMaj
Var gmVerMin
Var gmVerPat
Var gmVerKind
Var gmVerRc

; Parse scratch.
Var gmVerWork
Var gmVerNum
Var gmVerDigits
Var gmVerC
Var gmVerD
Var gmVerE

; The installed version's parse, kept while Setup's own version is parsed.
Var gmVerIMaj
Var gmVerIMin
Var gmVerIPat
Var gmVerIKind
Var gmVerIRc

; Takes a run of digits off the front of $gmVerWork. $gmVerNum is its value, $gmVerDigits how many
; digits there were (the caller accepts 1 to 9, so the sum below cannot overflow a 32-bit integer).
Function GmTakeNumber
  StrCpy $gmVerNum 0
  StrCpy $gmVerDigits 0
  take_next:
    StrCpy $gmVerC $gmVerWork 1
    StrCmp $gmVerC "" take_done
    StrCpy $gmVerD 0
  digit_scan:
    StrCpy $gmVerE "0123456789" 1 $gmVerD
    StrCmp $gmVerE $gmVerC digit_found
    IntOp $gmVerD $gmVerD + 1
    StrCmp $gmVerD 10 take_done digit_scan
  digit_found:
    IntOp $gmVerNum $gmVerNum * 10
    IntOp $gmVerNum $gmVerNum + $gmVerD
    IntOp $gmVerDigits $gmVerDigits + 1
    StrCpy $gmVerWork $gmVerWork "" 1
    Goto take_next
  take_done:
FunctionEnd

; Parses $gmVerIn. $gmVerOk is 1 and the other results are set only when it parses.
; $gmVerKind is 0 for an rc (with $gmVerRc its number) and 1 for a stable release.
Function GmParseVersion
  StrCpy $gmVerOk 0
  StrCpy $gmVerWork $gmVerIn

  Call GmTakeNumber
  StrCmp $gmVerDigits 0 parse_end
  IntCmp $gmVerDigits 9 +1 +1 parse_end
  StrCpy $gmVerMaj $gmVerNum
  StrCpy $gmVerC $gmVerWork 1
  StrCmp $gmVerC "." +1 parse_end
  StrCpy $gmVerWork $gmVerWork "" 1

  Call GmTakeNumber
  StrCmp $gmVerDigits 0 parse_end
  IntCmp $gmVerDigits 9 +1 +1 parse_end
  StrCpy $gmVerMin $gmVerNum
  StrCpy $gmVerC $gmVerWork 1
  StrCmp $gmVerC "." +1 parse_end
  StrCpy $gmVerWork $gmVerWork "" 1

  Call GmTakeNumber
  StrCmp $gmVerDigits 0 parse_end
  IntCmp $gmVerDigits 9 +1 +1 parse_end
  StrCpy $gmVerPat $gmVerNum

  ; Stable: nothing, or the end of the line, follows.
  StrCpy $gmVerC $gmVerWork 1
  StrCmp $gmVerC "" stable_ok
  StrCmp $gmVerC "$\r" stable_ok
  StrCmp $gmVerC "$\n" stable_ok

  ; Otherwise it must be exactly -rc.N (lower case) and then the end of the line.
  StrCpy $gmVerC $gmVerWork 4
  StrCmpS $gmVerC "-rc." +1 parse_end
  StrCpy $gmVerWork $gmVerWork "" 4
  Call GmTakeNumber
  StrCmp $gmVerDigits 0 parse_end
  IntCmp $gmVerDigits 9 +1 +1 parse_end
  StrCpy $gmVerRc $gmVerNum
  StrCpy $gmVerC $gmVerWork 1
  StrCmp $gmVerC "" rc_ok
  StrCmp $gmVerC "$\r" rc_ok
  StrCmp $gmVerC "$\n" rc_ok
  Goto parse_end

  rc_ok:
    StrCpy $gmVerKind 0
    StrCpy $gmVerOk 1
    Goto parse_end

  stable_ok:
    StrCpy $gmVerKind 1
    StrCpy $gmVerRc 0
    StrCpy $gmVerOk 1

  parse_end:
FunctionEnd

; Sets $gmVerWarn from $gmVerInstalledText and $gmVerSetupText. Cautious on every doubt: an installed
; version that does not parse, or a Setup version that does not, both ask the GM.
Function GmVersionNeedsWarning
  StrCpy $gmVerWarn 1

  StrCpy $gmVerIn $gmVerInstalledText
  Call GmParseVersion
  StrCmp $gmVerOk 1 +1 compare_end
  StrCpy $gmVerIMaj $gmVerMaj
  StrCpy $gmVerIMin $gmVerMin
  StrCpy $gmVerIPat $gmVerPat
  StrCpy $gmVerIKind $gmVerKind
  StrCpy $gmVerIRc $gmVerRc

  StrCpy $gmVerIn $gmVerSetupText
  Call GmParseVersion
  StrCmp $gmVerOk 1 +1 compare_end

  ; IntCmp a b equal less more. Installed more than Setup warns; less does not; equal goes on.
  IntCmp $gmVerIMaj $gmVerMaj +1 warn_no warn_yes
  IntCmp $gmVerIMin $gmVerMin +1 warn_no warn_yes
  IntCmp $gmVerIPat $gmVerPat +1 warn_no warn_yes

  ; Same X.Y.Z: a stable release (kind 1) is newer than an rc (kind 0).
  IntCmp $gmVerIKind $gmVerKind +1 warn_no warn_yes

  ; Both stable: the same version, nothing to say. Both rc: compare the rc numbers.
  StrCmp $gmVerKind 1 warn_no
  IntCmp $gmVerIRc $gmVerRc warn_no warn_no warn_yes

  warn_yes:
    StrCpy $gmVerWarn 1
    Goto compare_end
  warn_no:
    StrCpy $gmVerWarn 0
  compare_end:
FunctionEnd

!endif
