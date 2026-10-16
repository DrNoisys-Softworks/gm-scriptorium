'use strict';

/*
 * Structural pins for the Windows installer and uninstaller (ADR 0053).
 *
 * makensis builds the installer on Linux but nothing here can run it, so the rules that keep the
 * install per-user, the uninstall named-files-only and the settings untouched are pinned as source
 * rules over packaging/windows/installer.nsi and version.nsh, with comments stripped. Every regex
 * has a positive control (a line it must catch) and a negative control (a line it must not).
 * Behaviour at run time is verified on the Windows VM (criteria C143 to C146 and C151).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NSI_PATH = path.join(ROOT, 'packaging', 'windows', 'installer.nsi');
const NSH_PATH = path.join(ROOT, 'packaging', 'windows', 'version.nsh');

/**
 * Strips NSIS comments: `;` or `#` outside a string and at the start of a line or after
 * whitespace, and block comments. Strings may use any of the three quote characters; `$\"` is an
 * escaped quote and does not close a double-quoted string.
 */
function stripNsisComments(source) {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === '$' && line[i + 1] === '\\') {
            i += 2; // $\" $\' $\` and friends: an escape, never a closer
            continue;
          }
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') {
          quote = c;
          continue;
        }
        if ((c === ';' || c === '#') && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

const NSI_RAW = fs.existsSync(NSI_PATH) ? fs.readFileSync(NSI_PATH, 'utf8') : '';
const NSH_RAW = fs.existsSync(NSH_PATH) ? fs.readFileSync(NSH_PATH, 'utf8') : '';
const NSI = stripNsisComments(NSI_RAW);
const NSH = stripNsisComments(NSH_RAW);
const BOTH = `${NSI}\n${NSH}`;

/**
 * For each line, the stack of preprocessor conditions it sits inside, e.g. ['ifdef X'] or
 * ['ifndef X', 'else']. `!else` after `!ifdef X` is recorded as 'ifndef X' so a negated block is
 * never mistaken for the positive one.
 */
function conditionsPerLine(text) {
  const stack = [];
  return text.split('\n').map((line) => {
    const t = line.trim();
    let m;
    if ((m = /^!(ifdef|ifndef)\s+(\S+)/.exec(t))) {
      stack.push(`${m[1]} ${m[2]}`);
      return stack.slice();
    }
    if (/^!else\b/.test(t) && stack.length) {
      const top = stack.pop();
      const [kind, name] = top.split(' ');
      stack.push(`${kind === 'ifdef' ? 'ifndef' : 'ifdef'} ${name}`);
      return stack.slice();
    }
    if (/^!endif\b/.test(t)) {
      stack.pop();
      return stack.slice();
    }
    return stack.slice();
  });
}

/** Lines of `text` matching `re`, as { n, line, conds }. */
function findLines(text, re) {
  const conds = conditionsPerLine(text);
  return text
    .split('\n')
    .map((line, i) => ({ n: i + 1, line, conds: conds[i] }))
    .filter((x) => re.test(x.line));
}

/** True only for an https URL whose host is exactly tally.so. */
function isAllowedFeedbackUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' && parsed.hostname === 'tally.so';
  } catch {
    return false;
  }
}

/** The body of `Section Uninstall` up to its SectionEnd. */
function uninstallSection(text) {
  const m = /^\s*Section\s+Uninstall\b[^\n]*\n([\s\S]*?)^\s*SectionEnd\b/m.exec(text);
  return m ? m[1] : null;
}

/** The lines of `Function <name>` up to its FunctionEnd, or null. The name is compared whole. */
function functionBody(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `Function ${name}`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^\s*FunctionEnd\b/.test(l));
  return end === -1 ? null : lines.slice(start + 1, end).join('\n');
}

// ---------------------------------------------------------------------------------------------
// The comment stripper itself
// ---------------------------------------------------------------------------------------------

test('stripNsisComments: drops ; and # comments and block comments, keeps them inside strings', () => {
  const src = [
    '; whole line',
    '  # hash line',
    'Delete "$INSTDIR\\a.exe" ; trailing',
    'StrCmp $0 ";" +2',
    'MessageBox MB_OK "It$\\"s; fine # really"',
    '/* block',
    'RMDir /r "$INSTDIR"',
    '*/',
    'keep',
  ].join('\n');
  const out = stripNsisComments(src);
  assert.equal(out.includes('whole line'), false);
  assert.equal(out.includes('hash line'), false);
  assert.equal(out.includes('trailing'), false);
  assert.equal(out.includes('RMDir /r'), false);
  assert.equal(out.includes('StrCmp $0 ";" +2'), true);
  assert.equal(out.includes('fine # really'), true);
  assert.equal(out.includes('keep'), true);
});

test('functionBody: returns the lines between Function and FunctionEnd, comparing the name whole', () => {
  assert.equal(functionBody('Function un.X\n a\nFunctionEnd\n', 'un.X'), ' a');
  assert.equal(functionBody('Function unAX\n a\nFunctionEnd\n', 'un.X'), null);
  assert.equal(functionBody('Function un.XY\n a\nFunctionEnd\n', 'un.X'), null);
  assert.equal(functionBody('Function un.X\n a\n', 'un.X'), null);
});

test('conditionsPerLine: ifdef, else and endif nest correctly', () => {
  const lines = conditionsPerLine('a\n!ifdef X\nb\n!else\nc\n!endif\nd');
  assert.deepEqual(lines[0], []);
  assert.deepEqual(lines[2], ['ifdef X']);
  assert.deepEqual(lines[4], ['ifndef X']);
  assert.deepEqual(lines[6], []);
});

// ---------------------------------------------------------------------------------------------
// The sources exist
// ---------------------------------------------------------------------------------------------

test('installer.nsi and version.nsh exist and are not empty', () => {
  assert.ok(NSI.trim().length > 500, 'packaging/windows/installer.nsi is missing or empty');
  assert.ok(NSH.trim().length > 200, 'packaging/windows/version.nsh is missing or empty');
});

// ---------------------------------------------------------------------------------------------
// Required lines
// ---------------------------------------------------------------------------------------------

const REQUIRED = [
  {
    name: 'RequestExecutionLevel user',
    re: /^\s*RequestExecutionLevel\s+user\s*$/m,
    yes: 'RequestExecutionLevel user',
    no: 'RequestExecutionLevel admin',
  },
  { name: 'SetCompress off', re: /^\s*SetCompress\s+off\s*$/m, yes: 'SetCompress off', no: 'SetCompress auto' },
  {
    name: 'SetShellVarContext current',
    re: /^\s*SetShellVarContext\s+current\s*$/m,
    yes: '  SetShellVarContext current',
    no: 'SetShellVarContext all',
  },
  {
    name: 'Publisher is exactly DrNoisys Softworks',
    re: /^\s*!define\s+PUBLISHER\s+"DrNoisys Softworks"\s*$/m,
    yes: '!define PUBLISHER "DrNoisys Softworks"',
    no: '!define PUBLISHER "Someone Else"',
  },
  {
    name: 'the exact HKCU uninstall key',
    re: /^\s*!define\s+UNINST_KEY\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GM-Scriptorium"\s*$/m,
    yes: '!define UNINST_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GM-Scriptorium"',
    no: '!define UNINST_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other"',
  },
  { name: 'a RMDir "$INSTDIR" with no switch', re: /^\s*RMDir\s+"\$INSTDIR"\s*$/m, yes: '  RMDir "$INSTDIR"', no: 'RMDir /r "$INSTDIR"' },
];

for (const r of REQUIRED) {
  test(`required: ${r.name} (and its regex catches a positive and rejects a negative)`, () => {
    assert.equal(r.re.test(r.yes), true, 'positive control');
    assert.equal(r.re.test(r.no), false, 'negative control');
    assert.equal(r.re.test(NSI), true, `${r.name} is missing from installer.nsi`);
  });
}

test('required: the !uninstfinalize line sits inside !ifdef EXTRACT_UNINSTALLER', () => {
  const hits = findLines(NSI, /^\s*!uninstfinalize\b/);
  assert.equal(hits.length, 1, 'exactly one !uninstfinalize line');
  assert.ok(hits[0].conds.includes('ifdef EXTRACT_UNINSTALLER'), '!uninstfinalize must be inside !ifdef EXTRACT_UNINSTALLER');
  // control: the helper reports a line outside the block as outside
  const outside = findLines('!uninstfinalize "x"\n', /^\s*!uninstfinalize\b/);
  assert.equal(outside[0].conds.includes('ifdef EXTRACT_UNINSTALLER'), false);
});

test('required: stage B has no uninstall section and installs the signed uninstaller by File /oname', () => {
  const hits = findLines(NSI, /^\s*Section\s+Uninstall\b/);
  assert.ok(hits.length >= 1);
  for (const h of hits) assert.ok(h.conds.includes('ifdef EXTRACT_UNINSTALLER'), 'Section Uninstall only in stage A');
  assert.match(NSI, /^\s*File\s+"\/oname=Uninstall GM-Scriptorium\.exe"\s+"\$\{UNINSTALLER_IN\}"\s*$/m);
  const wu = findLines(NSI, /^\s*WriteUninstaller\b/);
  assert.ok(wu.length >= 1);
  for (const h of wu) assert.ok(h.conds.includes('ifdef EXTRACT_UNINSTALLER'), 'WriteUninstaller only in stage A');
});

test('required: both notices markers sit inside the uninstall section', () => {
  const body = uninstallSection(NSI);
  assert.ok(body, 'Section Uninstall not found');
  assert.equal(body.includes('Scriptorium: Third-Party Notices'), true, 'first marker');
  assert.equal(body.includes('Scriptorium version: '), true, 'second marker');
  // the first 40 lines and nothing longer
  assert.match(body, /\b40\b/);
  // control: a section without them is reported as lacking them
  const bare = uninstallSection('Section Uninstall\n  Delete "$INSTDIR\\x"\nSectionEnd\n');
  assert.equal(bare.includes('Scriptorium: Third-Party Notices'), false);
});

test('required: the notices file is deleted only inside a block that tested both markers', () => {
  const body = uninstallSection(NSI);
  const idxDelete = body.indexOf('Delete "$INSTDIR\\THIRD-PARTY-NOTICES.txt"');
  const idxMarker1 = body.indexOf('Scriptorium: Third-Party Notices');
  const idxMarker2 = body.indexOf('Scriptorium version: ');
  assert.ok(idxDelete > 0 && idxMarker1 > 0 && idxMarker2 > 0);
  // every marker test comes before the Delete that names the notices file
  assert.ok(idxMarker1 < idxDelete && idxMarker2 < idxDelete);
  // and the Delete is itself guarded by a test of both flags straight before it
  const before = body.slice(0, idxDelete).trimEnd().split('\n').slice(-3).join('\n');
  assert.match(before, /StrCmp \$2 1 0 notices_done\s+StrCmp \$3 1 0 notices_done/);
});

const START_READ_RE =
  /^\s*System::Call\s+'advapi32::RegGetValueW\(p 0x80000001, w "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run", w "GM-Scriptorium", i 0x1000ffff, p 0, p r\d, \*i 64 r\d\) i \.r\d'\s*$/;

/** The RegGetValueW lines of `text` split into the PATH reads (w "Environment") and all others. */
function splitRegGetValueW(text) {
  const hits = findLines(text, /RegGetValueW/);
  return { path: hits.filter((h) => /w "Environment"/.test(h.line)), others: hits.filter((h) => !/w "Environment"/.test(h.line)) };
}

test('required: every PATH write and PATH read is inside !ifdef WITH_PATH_OPTION, and the one other RegGetValueW is the Start with Windows read', () => {
  const writes = findLines(NSI, /^\s*(?:WriteReg\w+|DeleteRegValue|DeleteRegKey)\s+HKCU\s+"Environment"/);
  assert.ok(writes.length >= 2, 'expected the installer add and the uninstaller remove');
  for (const w of writes) assert.ok(w.conds.includes('ifdef WITH_PATH_OPTION'), `line ${w.n} writes PATH outside WITH_PATH_OPTION`);
  const { path: pathReads, others } = splitRegGetValueW(NSI);
  assert.ok(pathReads.length >= 1, 'RegGetValueW is the size and type read that guards every PATH write');
  for (const r of pathReads) assert.ok(r.conds.includes('ifdef WITH_PATH_OPTION'), `line ${r.n} reads PATH outside WITH_PATH_OPTION`);
  assert.equal(others.length, 1, 'exactly one RegGetValueW that is not a PATH read');
  const [one] = others;
  assert.match(one.line, START_READ_RE);
  assert.ok(one.conds.includes('ifndef EXTRACT_UNINSTALLER'), 'the Start with Windows read is in stage B');
  assert.equal(one.conds.includes('ifdef WITH_PATH_OPTION'), false, 'and outside the PATH option');
  const body = functionBody(NSI, 'GmAutostartRead');
  assert.ok(body, 'Function GmAutostartRead not found');
  assert.ok(body.split('\n').some((l) => l === one.line), 'the read sits inside Function GmAutostartRead');
  assert.equal(/\b(?:WriteReg\w*|DeleteReg\w*)\b/.test(body), false, 'the read function writes and deletes nothing');
  // controls
  const bad = findLines('WriteRegExpandStr HKCU "Environment" "Path" "x"\n', /^\s*(?:WriteReg\w+|DeleteRegValue|DeleteRegKey)\s+HKCU\s+"Environment"/);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].conds.includes('ifdef WITH_PATH_OPTION'), false);
  const twoOthers = splitRegGetValueW(
    [
      `  ${one.line.trim()}`,
      `  System::Call 'advapi32::RegGetValueW(p 0x80000001, w "Software\\Other", w "x", i 0x1000ffff, p 0, p r2, *i 64 r4) i .r0'`,
    ].join('\n'),
  );
  assert.equal(twoOthers.others.length, 2);
  const strayPath = splitRegGetValueW('System::Call \'advapi32::RegGetValueW(p 0x80000001, w "Environment", w "Path", i 0x1000ffff, *i .r1, p 0, *i .r2) i .r0\'\n');
  assert.equal(strayPath.path.length, 1);
  assert.equal(strayPath.path[0].conds.includes('ifdef WITH_PATH_OPTION'), false);
  assert.equal(START_READ_RE.test(`  System::Call 'advapi32::RegGetValueW(p 0x80000001, w "Software\\Other", w "GM-Scriptorium", i 0x1000ffff, p 0, p r2, *i 64 r4) i .r0'`), false);
});

test('required: the PATH guard compares against NSIS_MAX_STRLEN and checks the value was not truncated', () => {
  assert.match(NSI, /\$\{NSIS_MAX_STRLEN\}/);
  assert.match(NSI, /StrLen\s+\$\w+\s+\$gmPathVal/);
});

test('required: the PATH broadcast uses STR:Environment with a 5 second timeout', () => {
  assert.match(NSI, /SendMessage\s+\$\{HWND_BROADCAST\}\s+\$\{WM_SETTINGCHANGE\}\s+0\s+"STR:Environment"\s+\/TIMEOUT=5000/);
});

test('required: the running-copy probe, the temp name and the rename are all present', () => {
  assert.match(NSI, /FileOpen\s+\$\w+\s+"\$INSTDIR\\gm-scriptorium\.exe"\s+a\b/);
  assert.match(NSI, /MB_RETRYCANCEL/);
  assert.match(NSI, /"\/oname=gm-scriptorium\.exe-setup\.tmp"/);
  assert.match(NSI, /Rename\s+"\$INSTDIR\\gm-scriptorium\.exe-setup\.tmp"\s+"\$INSTDIR\\gm-scriptorium\.exe"/);
});

test('required: the newer-version warning defaults to Cancel', () => {
  assert.match(NSI, /MB_OKCANCEL\|MB_DEFBUTTON2/);
  assert.match(NSI, /nsExec::ExecToStack\s+'"\$INSTDIR\\gm-scriptorium\.exe" --version'/);
});

test('required: the shortcuts and the finish run start the tray app with no arguments', () => {
  assert.equal(findLines(NSI, /MUI_FINISHPAGE_RUN_PARAMETERS/).length, 0);
  const run = findLines(NSI, /^\s*!define\s+MUI_FINISHPAGE_RUN\s+"\$INSTDIR\\gm-scriptorium-tray\.exe"\s*$/);
  assert.equal(run.length, 1, 'the finish box starts the tray app, once');
  assert.equal(/^\s*!define\s+MUI_FINISHPAGE_RUN\s+"\$INSTDIR\\gm-scriptorium-tray\.exe"\s*$/.test('!define MUI_FINISHPAGE_RUN "$INSTDIR\\gm-scriptorium.exe"'), false);
  const shortcuts = findLines(NSI, /^\s*CreateShortCut\b/);
  assert.equal(shortcuts.length, 2, 'Start menu and Desktop');
  const re = /CreateShortCut\s+"\$(?:SMPROGRAMS|DESKTOP)\\GM-Scriptorium\.lnk"\s+"\$INSTDIR\\gm-scriptorium-tray\.exe"\s+""\s+"\$INSTDIR\\gm-scriptorium-tray\.exe"\s+0\s*$/;
  for (const s of shortcuts) assert.match(s.line, re);
  // control: a shortcut that targets the console program is refused
  assert.equal(re.test('CreateShortCut "$SMPROGRAMS\\GM-Scriptorium.lnk" "$INSTDIR\\gm-scriptorium.exe" "" "$INSTDIR\\gm-scriptorium.exe" 0'), false);
});

test('required: the uninstall key carries the listed values and nothing about a version', () => {
  for (const [name, re] of [
    ['DisplayName', /WriteRegStr\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"DisplayName"\s+"GM-Scriptorium"/],
    ['Publisher', /WriteRegStr\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"Publisher"\s+"\$\{PUBLISHER\}"/],
    ['UninstallString', /WriteRegStr\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"UninstallString"\s+"\$\\"\$INSTDIR\\Uninstall GM-Scriptorium\.exe\$\\""/],
    ['InstallLocation', /WriteRegStr\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"InstallLocation"\s+"\$INSTDIR"/],
    ['DisplayIcon', /WriteRegStr\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"DisplayIcon"\s+"\$INSTDIR\\gm-scriptorium\.exe,0"/],
    ['NoModify', /WriteRegDWORD\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"NoModify"\s+1/],
    ['NoRepair', /WriteRegDWORD\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"NoRepair"\s+1/],
    ['EstimatedSize', /WriteRegDWORD\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"EstimatedSize"\s+\$\w+/],
    ['StartMenuShortcut 1', /WriteRegDWORD\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"StartMenuShortcut"\s+1\s*$/m],
    ['StartMenuShortcut 0', /WriteRegDWORD\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"StartMenuShortcut"\s+0\s*$/m],
    ['DesktopShortcut 1', /WriteRegDWORD\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"DesktopShortcut"\s+1\s*$/m],
    ['DesktopShortcut 0', /WriteRegDWORD\s+HKCU\s+"\$\{UNINST_KEY\}"\s+"DesktopShortcut"\s+0\s*$/m],
  ]) {
    assert.match(NSI, re, name);
  }
});

test('required: version info on both exes names the product and the publisher', () => {
  assert.match(NSI, /VIProductVersion\s+"\$\{VERSION4\}"/);
  assert.match(NSI, /VIAddVersionKey\s+\/LANG=1033\s+"ProductName"\s+"GM-Scriptorium"/);
  assert.match(NSI, /VIAddVersionKey\s+\/LANG=1033\s+"CompanyName"\s+"\$\{PUBLISHER\}"/);
  assert.match(NSI, /VIAddVersionKey\s+\/LANG=1033\s+"FileDescription"\s+"GM-Scriptorium Setup"/);
  assert.match(NSI, /VIAddVersionKey\s+\/LANG=1033\s+"FileDescription"\s+"GM-Scriptorium Uninstall"/);
  assert.match(NSI, /VIAddVersionKey\s+\/LANG=1033\s+"FileVersion"\s+"\$\{VERSION\}"/);
});

test('required: the uninstaller finish page has an unticked feedback box that opens the hosted form', () => {
  const urls = [...NSI.matchAll(/https?:\/\/[^\s"'$]+/g)].map((m) => m[0]);
  assert.ok(urls.length >= 1, 'the feedback URL is defined');
  for (const u of urls) assert.equal(isAllowedFeedbackUrl(u), true, `${u} must be https on tally.so`);
  assert.match(NSI, /^\s*!define\s+FEEDBACK_URL\s+"https:\/\/tally\.so\/r\/[A-Za-z0-9]+"\s*$/m);
  assert.match(NSI, /ExecShell\s+"open"\s+"\$\{FEEDBACK_URL\}"/);
  const unFinish = /!define\s+MUI_FINISHPAGE_RUN_NOTCHECKED[\s\S]*?!insertmacro\s+MUI_UNPAGE_FINISH/m;
  assert.match(NSI, unFinish, 'the uninstaller finish page is declared with MUI_FINISHPAGE_RUN_NOTCHECKED');
  assert.match(NSI, /Leave feedback for the developer\. All feedback is read\./);
});

test('the feedback URL checker accepts https on tally.so and rejects everything else', () => {
  assert.equal(isAllowedFeedbackUrl('https://tally.so/r/eq19jQ'), true);
  for (const bad of [
    'http://tally.so/r/eq19jQ',
    'https://evil.example/r/eq19jQ',
    'https://tally.so.evil.example/r/eq19jQ',
    'https://eviltally.so/r/eq19jQ',
    'https://tally.so@evil.example/r/eq19jQ',
    'not a url',
  ]) {
    assert.equal(isAllowedFeedbackUrl(bad), false, bad);
  }
});

// ---------------------------------------------------------------------------------------------
// Forbidden lines
// ---------------------------------------------------------------------------------------------

const FORBIDDEN = [
  { name: 'RMDir /r', re: /^\s*RMDir\s+\/r\b/im, yes: '  RMDir /r "$INSTDIR"', no: 'RMDir "$INSTDIR"' },
  { name: 'HKLM', re: /\bHKLM\b|\bHKEY_LOCAL_MACHINE\b|\bSHCTX\b/i, yes: 'WriteRegStr HKLM "x" "y" "z"', no: 'WriteRegStr HKCU "x" "y" "z"' },
  { name: 'HKCR', re: /\bHKCR\b|\bHKEY_CLASSES_ROOT\b/i, yes: 'WriteRegStr HKCR ".x" "" "y"', no: 'WriteRegStr HKCU ".x" "" "y"' },
  { name: '$PROGRAMFILES', re: /\$PROGRAMFILES(?:32|64)?\b/i, yes: 'InstallDir "$PROGRAMFILES64\\GM"', no: 'InstallDir "$LOCALAPPDATA\\Programs\\GM"' },
  { name: 'SetShellVarContext all', re: /^\s*SetShellVarContext\s+all\b/im, yes: 'SetShellVarContext all', no: 'SetShellVarContext current' },
  {
    name: 'RequestExecutionLevel admin, highest or none',
    re: /^\s*RequestExecutionLevel\s+(?:admin|highest|none)\b/im,
    yes: 'RequestExecutionLevel highest',
    no: 'RequestExecutionLevel user',
  },
  { name: 'DisplayVersion', re: /DisplayVersion/i, yes: 'WriteRegStr HKCU "k" "DisplayVersion" "1"', no: 'WriteRegStr HKCU "k" "DisplayName" "1"' },
  { name: 'SetCompressor /SOLID', re: /^\s*SetCompressor\b[^\n]*\/SOLID\b/im, yes: 'SetCompressor /SOLID lzma', no: 'SetCompress off' },
  { name: 'any SetCompressor', re: /^\s*SetCompressor\b/im, yes: 'SetCompressor lzma', no: 'SetCompress off' },
  { name: 'SetCompress auto or force', re: /^\s*SetCompress\s+(?:auto|force)\b/im, yes: 'SetCompress auto', no: 'SetCompress off' },
  {
    name: 'a Delete or RMDir naming $APPDATA',
    re: /^\s*(?:Delete|RMDir)\b[^\n]*\$(?:APPDATA|LOCALAPPDATA\\Scriptorium|PROFILE\\AppData)/im,
    yes: 'Delete "$APPDATA\\Scriptorium\\config.toml"',
    no: 'Delete "$INSTDIR\\gm-scriptorium.exe"',
  },
  { name: 'RequestExecutionLevel via a define', re: /!define\s+REQEXECLEVEL/i, yes: '!define REQEXECLEVEL admin', no: '!define PUBLISHER "x"' },
];

for (const f of FORBIDDEN) {
  test(`forbidden: ${f.name} (and its regex catches a positive and rejects a negative)`, () => {
    assert.equal(f.re.test(f.yes), true, 'positive control');
    assert.equal(f.re.test(f.no), false, 'negative control');
    assert.equal(f.re.test(BOTH), false, `${f.name} found in the installer sources`);
  });
}

test('forbidden: any nsis comment that names a forbidden thing is not mistaken for code', () => {
  // the stripped text must not hide a real line behind a ; inside a string
  const risky = 'MessageBox MB_OK "a;b"\nRMDir /r "$INSTDIR"';
  assert.match(stripNsisComments(risky), /RMDir \/r/);
});

const ALLOWED_DELETES = new Set([
  '$INSTDIR\\gm-scriptorium.exe',
  '$INSTDIR\\Uninstall GM-Scriptorium.exe',
  '$INSTDIR\\gm-scriptorium.exe.old-*',
  '$INSTDIR\\gm-scriptorium.exe-update-*.tmp',
  '$INSTDIR\\gm-scriptorium.exe-setup.tmp',
  '$INSTDIR\\gm-scriptorium-tray.exe',
  '$INSTDIR\\gm-scriptorium-tray.exe.old-*',
  '$INSTDIR\\gm-scriptorium-tray.exe-update-*.tmp',
  '$INSTDIR\\gm-scriptorium-tray.exe-setup.tmp',
  '$INSTDIR\\THIRD-PARTY-NOTICES.txt',
  '$INSTDIR\\.gm-scriptorium-write-test',
  '$SMPROGRAMS\\GM-Scriptorium.lnk',
  '$DESKTOP\\GM-Scriptorium.lnk',
]);

const DELETE_RE = /^\s*Delete\s+(?:\/\w+\s+)*(.*?)\s*$/;

test('forbidden: a Delete whose path is not one of the named files or patterns', () => {
  const deletes = findLines(BOTH, /^\s*Delete\b/);
  assert.ok(deletes.length >= 8, `expected the installer and uninstaller deletes, found ${deletes.length}`);
  for (const d of deletes) {
    const arg = DELETE_RE.exec(d.line)[1];
    const m = /^"([^"]+)"$/.exec(arg);
    assert.ok(m, `line ${d.n}: Delete must take one quoted literal path, got ${arg}`);
    assert.ok(ALLOWED_DELETES.has(m[1]), `line ${d.n}: Delete names ${m[1]}, which is not an allowed file`);
  }
  // controls: the matcher flags a stray path and a variable path
  const stray = DELETE_RE.exec('Delete "$INSTDIR\\*.*"')[1];
  assert.equal(ALLOWED_DELETES.has(/^"([^"]+)"$/.exec(stray)[1]), false);
  assert.equal(/^"([^"]+)"$/.test(DELETE_RE.exec('Delete $0')[1]), false);
});

test('forbidden: any RMDir other than the bare install folder', () => {
  const rmdirs = findLines(BOTH, /^\s*RMDir\b/);
  assert.ok(rmdirs.length >= 1);
  for (const r of rmdirs) assert.match(r.line, /^\s*RMDir\s+"\$INSTDIR"\s*$/, `line ${r.n}`);
});

test('forbidden: the uninstall section removes the notices file, executables and shortcuts and nothing else by name', () => {
  const body = uninstallSection(NSI);
  const names = [...body.matchAll(/^\s*Delete\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(names)].sort(),
    [
      '$DESKTOP\\GM-Scriptorium.lnk',
      '$INSTDIR\\THIRD-PARTY-NOTICES.txt',
      '$INSTDIR\\Uninstall GM-Scriptorium.exe',
      '$INSTDIR\\gm-scriptorium.exe',
      '$INSTDIR\\gm-scriptorium-tray.exe',
      '$INSTDIR\\gm-scriptorium-tray.exe-setup.tmp',
      '$INSTDIR\\gm-scriptorium-tray.exe-update-*.tmp',
      '$INSTDIR\\gm-scriptorium-tray.exe.old-*',
      '$INSTDIR\\gm-scriptorium.exe-setup.tmp',
      '$INSTDIR\\gm-scriptorium.exe-update-*.tmp',
      '$INSTDIR\\gm-scriptorium.exe.old-*',
      '$SMPROGRAMS\\GM-Scriptorium.lnk',
    ].sort(),
  );
});

test('forbidden: nothing under the settings folder is written or deleted by any instruction', () => {
  const touching = findLines(BOTH, /^\s*(?:Delete|RMDir|Rename|CopyFiles|WriteIniStr|FileOpen|File)\b[^\n]*(?:APPDATA|config\.toml)/i);
  // only the display text may name the settings folder, and that is not one of these instructions
  assert.deepEqual(touching.map((t) => t.line.trim()), []);
});

test('version.nsh: pure string parsing, no registry, no file writes, no process starts', () => {
  for (const re of [/\bWriteReg\w*/i, /\bDeleteReg\w*/i, /\bDelete\b/, /\bRMDir\b/, /\bExec\w*\b/, /\bnsExec\b/, /\bFileOpen\b/]) {
    assert.equal(re.test(NSH), false, String(re));
  }
  assert.match(NSH, /^\s*Function\s+GmParseVersion\b/m);
  assert.match(NSH, /^\s*Function\s+GmVersionNeedsWarning\b/m);
  assert.match(NSH, /-rc\./);
});

test('the installer script gives its two build stages the defines installer.js passes', () => {
  for (const name of ['VERSION', 'VERSION4', 'OUTFILE', 'EXTRACT_UNINSTALLER', 'UNINSTALLER_OUT', 'EXE_IN', 'UNINSTALLER_IN', 'NOTICES_IN', 'TRAY_IN', 'WITH_PATH_OPTION']) {
    assert.match(NSI, new RegExp(`\\b${name}\\b`), name);
  }
});

// ---------------------------------------------------------------------------------------------
// The tray app is packed, replaced by temp file and rename, and probed (ADR 0058)
// ---------------------------------------------------------------------------------------------

test('tray: TRAY_IN is required in stage B only, and the tray File and Rename lines are present', () => {
  const guard = findLines(NSI, /^\s*!ifndef\s+TRAY_IN\s*$/);
  assert.equal(guard.length, 1);
  assert.ok(guard[0].conds.includes('ifndef EXTRACT_UNINSTALLER'), '!ifndef TRAY_IN must sit in stage B');
  const err = findLines(NSI, /^\s*!error\s+"TRAY_IN is required in the installer stage"\s*$/);
  assert.equal(err.length, 1);
  assert.ok(err[0].conds.includes('ifndef EXTRACT_UNINSTALLER'));
  assert.ok(err[0].conds.includes('ifndef TRAY_IN'));
  // control: a guard outside stage B is reported as outside
  const stray = findLines('!ifndef TRAY_IN\n!error "x"\n!endif\n', /^\s*!error\b/);
  assert.equal(stray[0].conds.includes('ifndef EXTRACT_UNINSTALLER'), false);
  const files = findLines(NSI, /^\s*File\s+"\/oname=gm-scriptorium-tray\.exe-setup\.tmp"\s+"\$\{TRAY_IN\}"\s*$/);
  assert.equal(files.length, 1);
  assert.ok(files[0].conds.includes('ifndef EXTRACT_UNINSTALLER'));
  const renames = findLines(NSI, /^\s*Rename\s+"\$INSTDIR\\gm-scriptorium-tray\.exe-setup\.tmp"\s+"\$INSTDIR\\gm-scriptorium-tray\.exe"\s*$/);
  assert.equal(renames.length, 1);
  // control: the exe rename is not the tray rename
  assert.equal(/Rename\s+"\$INSTDIR\\gm-scriptorium-tray\.exe-setup\.tmp"/.test('Rename "$INSTDIR\\gm-scriptorium.exe-setup.tmp" "$INSTDIR\\gm-scriptorium.exe"'), false);
});

test('tray: the running-copy probe also opens the tray app for writing, in both PreInstallChecks and un.RunningCheck', () => {
  const probe = /^FileOpen\s+\$\d\s+"\$INSTDIR\\gm-scriptorium-tray\.exe"\s+a$/;
  for (const name of ['PreInstallChecks', 'un.RunningCheck']) {
    const body = functionBody(NSI, name);
    assert.ok(body, `${name} not found`);
    const hits = body.split('\n').map((l) => l.trim()).filter((l) => probe.test(l));
    assert.equal(hits.length, 1, `${name} probes the tray app`);
  }
  // controls
  assert.equal(probe.test('FileOpen $0 "$INSTDIR\\gm-scriptorium-tray.exe" a'), true);
  assert.equal(probe.test('FileOpen $0 "$INSTDIR\\gm-scriptorium.exe" a'), false);
});

// ---------------------------------------------------------------------------------------------
// Commands, plug-ins, registry writes and the settings path (ADR 0058)
// ---------------------------------------------------------------------------------------------

const COMMAND_LINES = [
  `nsExec::ExecToStack '"$INSTDIR\\gm-scriptorium.exe" --version'`,
  `nsExec::ExecToLog '"$INSTDIR\\gm-scriptorium.exe" desktop set --port $gmPanelPort --preview-port $gmPreviewPort'`,
  `ExecWait '"$INSTDIR\\gm-scriptorium-tray.exe" --autostart on' $0`,
  `ExecWait '"$INSTDIR\\gm-scriptorium-tray.exe" --autostart off' $0`,
];
const COMMAND_RE = /(?:^|\s)(?:Exec|ExecWait)\s|nsExec::/;
const SHELL_LINE = 'ExecShell "open" "${FEEDBACK_URL}"';

/** The trimmed lines of `text` that start a program but are not one of the allowed lines. */
function strayCommands(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => COMMAND_RE.test(l) && !COMMAND_LINES.some((c) => c === l));
}

test('commands: only the four allowed command lines start a program, each once, and ExecShell opens only the feedback form', () => {
  assert.deepEqual(strayCommands(NSI), []);
  const lines = NSI.split('\n').map((l) => l.trim());
  for (const c of COMMAND_LINES) assert.equal(lines.filter((l) => l === c).length, 1, c);
  const shells = lines.filter((l) => /\bExecShell\w*/.test(l));
  assert.deepEqual(shells, [SHELL_LINE]);
  // controls
  assert.deepEqual(strayCommands(`nsExec::ExecToLog '"$INSTDIR\\gm-scriptorium.exe" desktop set --x on --yes'`).length, 1);
  assert.deepEqual(strayCommands(`Exec '"$INSTDIR\\gm-scriptorium-tray.exe"'`).length, 1);
  assert.deepEqual(strayCommands(COMMAND_LINES[2]), []);
});

test('no installer text, comment or argument names remote access or the sign-in setting', () => {
  assert.equal(/remote/i.test(NSI_RAW), false);
  assert.equal(/signin|sign-in|at_signin/i.test(NSI_RAW), false);
  // controls
  assert.equal(/remote/i.test('desktop set --Remote-at-signin on'), true);
  assert.equal(/signin|sign-in|at_signin/i.test('a sign-in setting'), true);
  assert.equal(/signin|sign-in|at_signin/i.test('remote_at_signin'), true);
  assert.equal(/signin|sign-in|at_signin/i.test('when I sign in to Windows'), false);
});

const REG_TARGET_RE = /^\s*WriteReg\w+\s+HKCU\s+(?:"\$\{UNINST_KEY\}"|"Environment")\s/;

test('registry: every WriteReg line targets the uninstall key or the user environment, never Run or StartupApproved', () => {
  const writes = BOTH.split('\n').filter((l) => /^\s*WriteReg\w+/.test(l));
  assert.ok(writes.length >= 10);
  for (const w of writes) assert.match(w, REG_TARGET_RE, w.trim());
  // controls
  assert.equal(REG_TARGET_RE.test('WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "GM-Scriptorium" "x"'), false);
  assert.equal(REG_TARGET_RE.test('WriteRegStr HKCU "${RUN_KEY}" "GM-Scriptorium" "x"'), false);
  assert.equal(REG_TARGET_RE.test('WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1'), true);
  assert.equal(REG_TARGET_RE.test('WriteRegExpandStr HKCU "Environment" "Path" "x"'), true);
});

const CONFIG_PATH_FORMS = [
  'ReadEnvStr $gmConfigPath SCRIPTORIUM_CONFIG',
  'StrCmp $gmConfigPath "" 0 +2',
  'StrCpy $gmConfigPath "$APPDATA\\Scriptorium\\config.toml"',
  'IfFileExists "$gmConfigPath" 0 +2',
  'Var gmConfigPath',
];
const CONFIG_LABEL_RE = /^\s*\$\{NSD_CreateLabel\}\s+\S+\s+\S+\s+\S+\s+\S+\s+"Settings file: \$gmConfigPath"\s*$/;

/** The trimmed lines naming $gmConfigPath (or its Var) that are not one of the allowed forms. */
function strayConfigPathLines(text) {
  return text
    .split('\n')
    .filter((l) => /gmConfigPath/.test(l))
    .filter((l) => !CONFIG_PATH_FORMS.some((f) => f === l.trim()) && !CONFIG_LABEL_RE.test(l))
    .map((l) => l.trim());
}

test('settings: the settings path is only looked for with IfFileExists and shown in one label, never opened', () => {
  assert.deepEqual(strayConfigPathLines(NSI), []);
  const lines = NSI.split('\n').map((l) => l.trim());
  assert.equal(lines.filter((l) => l === 'IfFileExists "$gmConfigPath" 0 +2').length, 1);
  assert.equal(lines.filter((l) => l === 'ReadEnvStr $gmConfigPath SCRIPTORIUM_CONFIG').length, 1);
  assert.equal(NSI.split('\n').filter((l) => CONFIG_LABEL_RE.test(l)).length, 1);
  // controls
  assert.equal(strayConfigPathLines('FileOpen $0 "$gmConfigPath" r').length, 1);
  assert.equal(strayConfigPathLines('CopyFiles "$gmConfigPath" "$TEMP"').length, 1);
  assert.equal(strayConfigPathLines('  IfFileExists "$gmConfigPath" 0 +2').length, 0);
  assert.equal(CONFIG_LABEL_RE.test('${NSD_CreateLabel} 0 0 100% 18u "Settings file: $gmConfigPath"'), true);
  assert.equal(CONFIG_LABEL_RE.test('${NSD_CreateLabel} 0 0 100% 18u "Settings file: $gmConfigPath and more"'), false);
});

const PLUGIN_CALLS = ['System::Alloc', 'System::Call', 'System::Free', 'nsDialogs::Create', 'nsDialogs::Show', 'nsExec::ExecToLog', 'nsExec::ExecToStack'];
const SYSTEM_LINES = [
  `System::Call 'advapi32::RegGetValueW(p 0x80000001, w "Environment", w "Path", i 0x1000ffff, *i .r1, p 0, *i .r2) i .r0'`,
  `System::Call '*$2(&i1 .r3)'`,
  'System::Alloc 64',
  'System::Free $2',
];

/** Plug-in calls (a word, two colons, a word at the start of a trimmed line) that are not allowed. */
function strayPluginLines(text) {
  const lines = text.split('\n').map((l) => l.trim());
  return lines.filter((l) => {
    const m = /^([A-Za-z]\w*::\w+)/.exec(l);
    if (!m) return false;
    if (!PLUGIN_CALLS.some((p) => p === m[1])) return true;
    if (/^System::/.test(l)) return !(SYSTEM_LINES.some((f) => f === l) || START_READ_RE.test(l));
    return false;
  });
}

test('plug-ins: the plug-in calls are exactly the allowed set, and every System line is one of the allowed forms', () => {
  assert.deepEqual(strayPluginLines(NSI), []);
  const used = new Set(NSI.split('\n').map((l) => /^\s*([A-Za-z]\w*::\w+)/.exec(l)).filter(Boolean).map((m) => m[1]));
  assert.deepEqual([...used].sort(), PLUGIN_CALLS.slice().sort());
  // controls
  assert.equal(strayPluginLines(`System::Call 'kernel32::CreateProcessW(p 0)'`).length, 1);
  assert.equal(strayPluginLines(`System::Call 'shell32::ShellExecuteW(p 0)'`).length, 1);
  assert.equal(strayPluginLines('NSISdl::download x y').length, 1);
  assert.equal(strayPluginLines('System::Alloc 64').length, 0);
});

test('order: the Start with Windows switch runs only after the tray app is renamed into place', () => {
  const lines = NSI.split('\n').map((l) => l.trim());
  const rename = lines.findIndex((l) => l === 'Rename "$INSTDIR\\gm-scriptorium-tray.exe-setup.tmp" "$INSTDIR\\gm-scriptorium-tray.exe"');
  assert.ok(rename > 0);
  const switches = lines.map((l, i) => ({ l, i })).filter((x) => /--autostart/.test(x.l));
  assert.equal(switches.length, 2);
  for (const x of switches) assert.ok(rename < x.i, `${x.l} comes before the tray rename`);
  const start = lines.findIndex((l) => l === 'Section "-Start with Windows"');
  const end = lines.findIndex((l, i) => i > start && l === 'SectionEnd');
  assert.ok(start > 0 && end > start);
  for (const x of switches) assert.ok(x.i > start && x.i < end, `${x.l} is outside Section "-Start with Windows"`);
  // control: the section that sits above the tray rename is reported
  const early = ['Section "-Start with Windows"', "ExecWait '\"$INSTDIR\\x.exe\" --autostart on' $0", 'SectionEnd', 'Rename "a" "b"'];
  assert.ok(early.findIndex((l) => l === 'Rename "a" "b"') > early.findIndex((l) => /--autostart/.test(l)));
});

test('options page: the components page and its leftovers are gone', () => {
  const gone = [
    'Setup always adds a Start menu shortcut. Tick anything else you want.',
    'Always added. Find ${APP_NAME} by typing its name in Start.',
    'Find it in the Start menu under G.',
    'Open ${APP_NAME} now',
    'or use the Start menu shortcut.',
    'MUI_PAGE_COMPONENTS',
    'MUI_COMPONENTSPAGE_TEXT_TOP',
    'SectionIn',
  ];
  for (const g of gone) assert.equal(NSI_RAW.includes(g), false, `${g} is still in installer.nsi`);
  // control: the check would see one
  assert.equal('Section x\n  SectionIn RO\nSectionEnd'.includes('SectionIn'), true);
});
