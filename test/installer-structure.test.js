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

test('required: the build stops when makensis does not define NSIS_MAX_STRLEN', () => {
  // A shape test: it pins the guard text and proves nothing about Windows.
  const GUARD_RE = /!ifndef\s+NSIS_MAX_STRLEN\s*\n\s*!error\s+"NSIS_MAX_STRLEN is not defined by this makensis"\s*\n\s*!endif/;
  assert.match(NSI, GUARD_RE);
  assert.equal(GUARD_RE.test('!ifdef NSIS_MAX_STRLEN\n  !error "NSIS_MAX_STRLEN is not defined by this makensis"\n!endif'), false);
  assert.equal(GUARD_RE.test('!ifndef NSIS_MAX_STRLEN\n  !error "something else"\n!endif'), false);
  // The guard sits at the top level, before the first include.
  assert.ok(NSI.search(GUARD_RE) < NSI.indexOf('!include "MUI2.nsh"'));
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

// The one other address Setup opens: the documentation index, from the first-campaign page.
const DOCS_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/blob/main/docs/README.md';
const isAllowedUrl = (u) => isAllowedFeedbackUrl(u) || u === DOCS_URL;

test('required: the uninstaller finish page has an unticked feedback box that opens the hosted form', () => {
  const urls = [...NSI.matchAll(/https?:\/\/[^\s"'$]+/g)].map((m) => m[0]);
  assert.ok(urls.length >= 1, 'the feedback URL is defined');
  for (const u of urls) assert.equal(isAllowedUrl(u), true, `${u} must be the feedback form on tally.so or the documentation index`);
  assert.equal(NSI.split('\n').filter((l) => l.trim() === `!define DOCS_URL "${DOCS_URL}"`).length, 1);
  // controls: the documentation address with anything added, another host and another repository are refused
  assert.equal(isAllowedUrl(DOCS_URL), true);
  assert.equal(isAllowedUrl(`${DOCS_URL}.x`), false);
  assert.equal(isAllowedUrl('https://github.com.evil.example/DrNoisys-Softworks/gm-scriptorium/blob/main/docs/README.md'), false);
  assert.equal(isAllowedUrl('https://github.com/evil/gm-scriptorium/blob/main/docs/README.md'), false);
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
  for (const name of ['VERSION', 'VERSION4', 'OUTFILE', 'EXTRACT_UNINSTALLER', 'UNINSTALLER_OUT', 'EXE_IN', 'UNINSTALLER_IN', 'NOTICES_IN', 'TRAY_IN', 'STARTER_SYSTEMS', 'WITH_PATH_OPTION']) {
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
  `nsExec::ExecToStack '"$INSTDIR\\gm-scriptorium.exe" init --yes --name "$gmArgName" --vault "$gmArgVault" --out "$gmArgOut"'`,
  `nsExec::ExecToStack '"$INSTDIR\\gm-scriptorium.exe" init --yes --name "$gmArgName" --new-vault "$gmArgVault" --system "$gmSystem" --out "$gmArgOut"'`,
];
const COMMAND_RE = /(?:^|\s)(?:Exec|ExecWait)\s|nsExec::/;
const SHELL_LINE = 'ExecShell "open" "${FEEDBACK_URL}"';
const DOCS_SHELL_LINE = 'ExecShell "open" "${DOCS_URL}"';

/** The trimmed lines of `text` that start a program but are not one of the allowed lines. */
function strayCommands(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => COMMAND_RE.test(l) && !COMMAND_LINES.some((c) => c === l));
}

test('commands: only the six allowed command lines start a program, each once, and ExecShell opens only the feedback form and the documentation index', () => {
  assert.deepEqual(strayCommands(NSI), []);
  const lines = NSI.split('\n').map((l) => l.trim());
  for (const c of COMMAND_LINES) assert.equal(lines.filter((l) => l === c).length, 1, c);
  const shells = lines.filter((l) => /\bExecShell\w*/.test(l));
  assert.deepEqual(shells.slice().sort(), [SHELL_LINE, DOCS_SHELL_LINE].sort());
  // controls
  assert.deepEqual(strayCommands(`nsExec::ExecToLog '"$INSTDIR\\gm-scriptorium.exe" desktop set --x on --yes'`).length, 1);
  assert.deepEqual(strayCommands(`Exec '"$INSTDIR\\gm-scriptorium-tray.exe"'`).length, 1);
  assert.deepEqual(strayCommands(COMMAND_LINES[2]), []);
  assert.equal(strayCommands(`${COMMAND_LINES[4].slice(0, -1)} --config x'`).length, 1, 'the existing-vault line with a config flag is stray');
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

const PATH_CALL_LINE = "System::Call 'advapi32::RegGetValueW(p 0x80000001, w \"Environment\", w \"Path\", i 0x1000ffff, *i .r1, p r2, *i ${GM_PATH_BUF_BYTES} r4) i .r0'";
const PATH_WCHAR_LINE = "System::Call '*$5(&i2 .r6)'";
const PATH_ALLOC_LINE = 'System::Alloc ${GM_PATH_BUF_BYTES}';
const PATH_FREE_LINE = 'System::Free $2';

/** The trimmed lines of a function body that equal `line`. */
function countExact(body, line) {
  return body.split('\n').filter((l) => l.trim() === line).length;
}

test('required: GmPathRead reads the whole stored PATH into a buffer, trims closing NULs and cross-checks the length', () => {
  // A shape test: it pins the source and proves nothing about Windows (the VM criterion C212 does that).
  const body = functionBody(NSI, '${UN}GmPathRead');
  assert.ok(body, 'Function ${UN}GmPathRead not found');
  const lines = body.split('\n').map((l) => l.trim());
  // the buffer define is inside the PATH option, and the exact lines appear once each, inside the function
  const define = findLines(NSI, /^\s*!define \/math GM_PATH_BUF_BYTES \$\{NSIS_MAX_STRLEN\} \* 2\s*$/);
  assert.equal(define.length, 1);
  assert.ok(define[0].conds.includes('ifdef WITH_PATH_OPTION'));
  for (const line of [PATH_CALL_LINE, PATH_WCHAR_LINE, PATH_ALLOC_LINE]) {
    const hits = findLines(NSI, /^\s*System::/).filter((h) => h.line.trim() === line);
    assert.equal(hits.length, 1, `${line} must appear once`);
    assert.ok(hits[0].conds.includes('ifdef WITH_PATH_OPTION'), `${line} is outside WITH_PATH_OPTION`);
    assert.equal(countExact(body, line), 1, `${line} must sit inside GmPathRead`);
  }
  assert.equal(countExact(body, PATH_FREE_LINE), 1);
  assert.equal(NSI.includes('2048'), false, 'the buffer size is the define, never a literal');
  // no size-only read, and the old size derived count is gone
  assert.equal(/RegGetValueW\([^)]*i 0x1000ffff, \*i \.r1, p 0, \*i \.r2\)/.test(NSI), false, 'size-only RegGetValueW is back');
  assert.equal(/IntOp \$\w+ \$\w+ \/ 2\s*\n\s*IntOp \$\w+ \$\w+ - 1/.test(body), false, 'size / 2 - 1 is back');
  // outcomes
  const idx = (re) => lines.findIndex((l) => re.test(l));
  assert.ok(idx(/^IntCmp \$0 2 path_absent \+1 path_unsafe$/) >= 0, 'error 2 goes to path_absent, other errors to path_unsafe');
  assert.ok(idx(/^IntCmp \$0 0 \+1 path_unsafe path_unsafe$/) >= 0);
  assert.ok(idx(/^IntCmp \$1 2 path_typed path_unsafe path_unsafe$/) >= 0, 'a wrong type goes to path_unsafe');
  assert.ok(idx(/^IntCmp \$7 0 \+1 path_unsafe path_unsafe$/) >= 0, 'an odd byte count goes to path_unsafe');
  assert.ok(idx(/^StrCmp \$2 0 path_done$/) >= 0, 'a failed Alloc leaves the value alone');
  // the trailing zero scan stops at the first non-zero WCHAR from the end
  assert.ok(idx(/^IntCmp \$6 0 \+1 path_scanned path_scanned$/) >= 0, 'the scan stops at a non-zero WCHAR');
  assert.ok(idx(/^IntCmp \$3 0 path_scanned path_scanned \+1$/) >= 0, 'the scan never reads below index 0');
  // the cross-check: the error flag and StrLen against D go to path_unsafe
  assert.ok(idx(/^IfErrors path_unsafe$/) >= 0);
  assert.ok(lines.includes('StrLen $5 $gmPathVal'));
  assert.ok(idx(/^IntCmp \$5 \$3 \+1 path_unsafe path_unsafe$/) >= 0, 'StrLen must equal D');
  // the size check keeps its form and runs on D
  assert.ok(lines.includes('IntOp $5 ${NSIS_MAX_STRLEN} - 1'));
  assert.ok(lines.includes('IntOp $4 $3 + $4'));
  assert.ok(idx(/^IntCmp \$4 \$5 path_unsafe \+1 path_unsafe$/) >= 0);
  // every register is pushed at entry and popped in reverse, all exits go through path_done
  const push = lines.filter((l) => /^Push \$\d$/.test(l)).map((l) => l.slice(5));
  const pop = lines.slice(lines.indexOf('path_popped:')).filter((l) => /^Pop \$\d$/.test(l)).map((l) => l.slice(4));
  assert.deepEqual(push, ['$0', '$1', '$2', '$3', '$4', '$5', '$6', '$7']);
  assert.deepEqual(pop, push.slice().reverse());
  const free = lines.indexOf(PATH_FREE_LINE);
  assert.ok(lines.indexOf('path_done:') >= 0 && lines.indexOf('path_done:') < free, 'the Free is on the path_done path');
  assert.ok(free < lines.indexOf('Pop $7'));
  // the function is inserted exactly once for Setup and once for the uninstaller
  assert.equal(NSI.split('\n').filter((l) => l.trim() === '!insertmacro GmPathCommon ""').length, 1);
  assert.equal(NSI.split('\n').filter((l) => l.trim() === '!insertmacro GmPathCommon "un."').length, 1);
  // controls
  assert.equal(/IntOp \$\w+ \$\w+ \/ 2\s*\n\s*IntOp \$\w+ \$\w+ - 1/.test('IntOp $3 $2 / 2\n  IntOp $3 $3 - 1'), true);
  assert.equal(/IntOp \$\w+ \$\w+ \/ 2\s*\n\s*IntOp \$\w+ \$\w+ - 1/.test('IntOp $3 $4 / 2\nStrLen $4 "x"'), false);
  assert.equal(/RegGetValueW\([^)]*i 0x1000ffff, \*i \.r1, p 0, \*i \.r2\)/.test(`System::Call 'advapi32::RegGetValueW(p 0x80000001, w "Environment", w "Path", i 0x1000ffff, *i .r1, p 0, *i .r2) i .r0'`), true);
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

const PLUGIN_CALLS = ['System::Alloc', 'System::Call', 'System::Free', 'nsDialogs::Create', 'nsDialogs::SelectFolderDialog', 'nsDialogs::Show', 'nsExec::ExecToLog', 'nsExec::ExecToStack'];
// The twelve System lines of un.GmFinishShow (stage A). Named so no test indexes SYSTEM_LINES by position.
const UNFIN_LINES = {
  alloc: `System::Call '*(i 0, i 0, i 0, i 0) p .r1'`,
  origin: `System::Call 'user32::ClientToScreen(p $mui.FinishPage, p r1) i .r0'`,
  originRead: `System::Call '*$1(i .r8, i .r9)'`,
  runRect: `System::Call 'user32::GetWindowRect(p $mui.FinishPage.Run, p r1) i .r0'`,
  runRead: `System::Call '*$1(i .r4, i .r5, i, i .r6)'`,
  textRect: `System::Call 'user32::GetWindowRect(p $mui.FinishPage.Text, p r1) i .r0'`,
  textRead: `System::Call '*$1(i .r8, i .r2, i .r0, i .r3)'`,
  clientRect: `System::Call 'user32::GetClientRect(p $mui.FinishPage, p r1) i .r0'`,
  clientRead: `System::Call '*$1(i, i, i, i .r7)'`,
  free: 'System::Free $1',
  moveText: `System::Call 'user32::SetWindowPos(p $mui.FinishPage.Text, p 0, i 0, i 0, i r8, i r3, i 0x16)'`,
  moveBox: `System::Call 'user32::SetWindowPos(p $mui.FinishPage.Run, p 0, i r4, i r7, i 0, i 0, i 0x15)'`,
};
// The System lines of GmNextFit and GmNextRestore (issue 213), stage B. Each is textually unique in the
// file, because UNFIN_LINES must be unique and System::Free $2 already appears twice.
const NEXT_FIT_LINES = {
  alloc: `System::Call '*(i 0, i 0, i 0, i 0) p .r4'`,
  getDc: `System::Call 'user32::GetDC(p r0) p .r2'`,
  select: `System::Call 'gdi32::SelectObject(p r2, p r1) p .r3'`,
  extent: `System::Call 'gdi32::GetTextExtentPoint32W(p r2, w "Close and continue", i 18, p r4) i .r5'`,
  reselect: `System::Call 'gdi32::SelectObject(p r2, p r3) p .r6'`,
  release: `System::Call 'user32::ReleaseDC(p r0, p r2) i .r6'`,
  sizeRead: `System::Call '*$4(i .r7)'`,
  zero: `System::Call '*$4(i 0, i 0)'`,
  origin: `System::Call 'user32::ClientToScreen(p $HWNDPARENT, p r4) i .r5'`,
  originRead: `System::Call '*$4(i .r5, i .r6)'`,
  nextRect: `System::Call 'user32::GetWindowRect(p r0, p r4) i .r8'`,
  nextRead: `System::Call '*$4(i .r8, i .r9, i .r2, i .r3)'`,
  backRect: `System::Call 'user32::GetWindowRect(p r9, p r4) i .r8'`,
  backRead: `System::Call '*$4(i .r8, i .r2)'`,
  moveNext: `System::Call 'user32::SetWindowPos(p r0, p 0, i r1, i $gmNextY, i r3, i $gmNextH, i 0x14) i .r8'`,
  moveBack: `System::Call 'user32::SetWindowPos(p r9, p 0, i r2, i $gmBackY, i 0, i 0, i 0x15) i .r8'`,
  free: 'System::Free $4',
  putNext: `System::Call 'user32::SetWindowPos(p r0, p 0, i $gmNextX, i $gmNextY, i $gmNextW, i $gmNextH, i 0x14) i .r2'`,
  putBack: `System::Call 'user32::SetWindowPos(p r1, p 0, i $gmBackX, i $gmBackY, i 0, i 0, i 0x15) i .r2'`,
};
// The System lines of GmFromUtf8 (issue 214), stage B.
const UTF8_LINES = {
  size: `System::Call 'kernel32::WideCharToMultiByte(i 0, i 0x400, w r0, i -1, p 0, i 0, p 0, p 0) i .r4'`,
  alloc: 'System::Alloc $4',
  toAcp: `System::Call 'kernel32::WideCharToMultiByte(i 0, i 0x400, w r0, i -1, p r3, i r4, p 0, *i 0 r2) i .r4'`,
  toWide: `System::Call 'kernel32::MultiByteToWideChar(i 65001, i 8, p r3, i -1, w .r5, i \${NSIS_MAX_STRLEN}) i .r4'`,
  free: 'System::Free $3',
};
const SYSTEM_LINES = [
  PATH_CALL_LINE,
  PATH_WCHAR_LINE,
  PATH_ALLOC_LINE,
  `System::Call '*$2(&i1 .r3)'`,
  'System::Alloc 64',
  'System::Free $2',
  // The uninstaller finish page callback (un.GmFinishShow), stage A only. Named, never indexed.
  ...Object.values(UNFIN_LINES),
  ...Object.values(NEXT_FIT_LINES),
  ...Object.values(UTF8_LINES),
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

// ---------------------------------------------------------------------------------------------
// What the uninstaller removes, the running-copy close, page order and the copy (ADR 0058)
// ---------------------------------------------------------------------------------------------

const RUN_VALUE_LINES = [
  'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "GM-Scriptorium"',
  'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "GM-Scriptorium"',
];
const RUN_VALUE_RE = /^\s*DeleteRegValue\b[^\n]*(?:CurrentVersion\\Run"|StartupApproved)/;

/** How many Run or StartupApproved value deletes `text` holds in all, and inside its uninstall section. */
function runValueDeletes(text) {
  const all = text.split('\n').filter((l) => RUN_VALUE_RE.test(l));
  const body = uninstallSection(text);
  const inBody = body === null ? [] : body.split('\n').filter((l) => RUN_VALUE_RE.test(l));
  return { all, inBody };
}

test('uninstall: the Run and StartupApproved value deletes are exactly the two named ones, and both are in the uninstall section', () => {
  const { all, inBody } = runValueDeletes(NSI);
  assert.deepEqual(all.map((l) => l.trim()), RUN_VALUE_LINES);
  assert.equal(all.length, inBody.length, 'no such delete outside the uninstall section');
  // control: one in stage B is counted outside the section
  const bad = runValueDeletes(`${RUN_VALUE_LINES[0]}\nSection Uninstall\n  ${RUN_VALUE_LINES[1]}\nSectionEnd\n`);
  assert.equal(bad.all.length, 2);
  assert.equal(bad.inBody.length, 1);
});

const REG_KEY_LINES = ['DeleteRegKey HKCU "${UNINST_KEY}"', 'DeleteRegKey HKCU "Software\\GM-Scriptorium"'];

test('uninstall: the only keys deleted whole are the uninstall key and the tray app\'s notification record', () => {
  const body = uninstallSection(NSI);
  const inBody = body.split('\n').map((l) => l.trim()).filter((l) => /^DeleteRegKey\b/.test(l));
  const all = BOTH.split('\n').map((l) => l.trim()).filter((l) => /^DeleteRegKey\b/.test(l));
  assert.deepEqual(all.slice().sort(), REG_KEY_LINES.slice().sort());
  assert.deepEqual(inBody.slice().sort(), REG_KEY_LINES.slice().sort());
  // control
  assert.equal(REG_KEY_LINES.some((l) => l === 'DeleteRegKey HKCU "Software"'), false);
});

test('uninstall: each shortcut is deleted once, straight behind its record read and the guard, before the uninstall key goes', () => {
  const lines = uninstallSection(NSI).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !/^;/.test(l));
  const check = (ls) => {
    const out = [];
    for (const [del, rec] of [
      ['Delete "$SMPROGRAMS\\GM-Scriptorium.lnk"', 'ReadRegDWORD $0 HKCU "${UNINST_KEY}" "StartMenuShortcut"'],
      ['Delete "$DESKTOP\\GM-Scriptorium.lnk"', 'ReadRegDWORD $0 HKCU "${UNINST_KEY}" "DesktopShortcut"'],
    ]) {
      const at = ls.map((l, i) => (l === del ? i : -1)).filter((i) => i >= 0);
      if (at.length !== 1) out.push(`${del} appears ${at.length} times`);
      else if (ls[at[0] - 1] !== 'StrCmp $0 1 0 +2' || ls[at[0] - 2] !== rec) out.push(`${del} is not guarded by ${rec}`);
    }
    const reads = ls.findIndex((l) => l === 'ReadRegDWORD $0 HKCU "${UNINST_KEY}" "DesktopShortcut"');
    const dropKey = ls.findIndex((l) => l === 'DeleteRegKey HKCU "${UNINST_KEY}"');
    if (!(reads >= 0 && dropKey > reads)) out.push('the records are read after the uninstall key goes');
    return out;
  };
  assert.deepEqual(check(lines), []);
  // controls: an unguarded delete is reported, and so is a record read after the key is deleted
  const unguarded = lines.filter((l) => l !== 'StrCmp $0 1 0 +2');
  assert.ok(check(unguarded).length >= 1);
  const late = ['DeleteRegKey HKCU "${UNINST_KEY}"', ...lines.filter((l) => l !== 'DeleteRegKey HKCU "${UNINST_KEY}"')];
  assert.ok(check(late).length >= 1);
});

test('tray close: the window class equals the tray app\'s, and the close, the wait and the wiring are as built', () => {
  const header = fs.readFileSync(path.join(ROOT, 'packaging', 'windows', 'tray', 'tray.h'), 'utf8');
  const fromHeader = /^#define TRAY_WINDOW_CLASS L"([^"]+)"$/m.exec(header);
  const fromNsi = /^\s*!define\s+TRAY_WINDOW_CLASS\s+"([^"]+)"\s*$/m.exec(NSI);
  assert.ok(fromHeader && fromNsi);
  assert.equal(fromNsi[1], fromHeader[1]);
  // control: a mismatched class is reported
  const mism = /^\s*!define\s+TRAY_WINDOW_CLASS\s+"([^"]+)"\s*$/m.exec('!define TRAY_WINDOW_CLASS "GMScriptoriumTrayX"');
  assert.notEqual(mism[1], fromHeader[1]);

  const lines = NSI.split('\n').map((l) => l.trim());
  const finds = lines.filter((l) => /^FindWindow\b/.test(l));
  assert.ok(finds.length >= 3, 'GmCloseTray, GmRunningShow and un.ConfirmShow each look for the window');
  for (const f of finds) assert.match(f, /^FindWindow \$\d "\$\{TRAY_WINDOW_CLASS\}"$/);
  assert.equal(lines.filter((l) => /^SendMessage \$\d \$\{WM_CLOSE\} 0 0 \/TIMEOUT=15000$/.test(l)).length, 1);
  assert.equal(lines.filter((l) => l === '!insertmacro GmTrayCommon ""').length, 1);
  assert.equal(lines.filter((l) => l === '!insertmacro GmTrayCommon "un."').length, 1);
  const stageB = findLines(NSI, /^\s*!insertmacro\s+GmTrayCommon\s+""\s*$/);
  assert.ok(stageB[0].conds.includes('ifndef EXTRACT_UNINSTALLER'));
  const stageA = findLines(NSI, /^\s*!insertmacro\s+GmTrayCommon\s+"un\."\s*$/);
  assert.ok(stageA[0].conds.includes('ifdef EXTRACT_UNINSTALLER'));

  // the wait: the send, then the probe, the count, the pause and the loop, in that order
  const body = functionBody(NSI, '${UN}GmCloseTray');
  assert.ok(body, 'the shared close function is missing');
  const inOrder = (text) => {
    const ls = text.split('\n').map((l) => l.trim());
    const want = [
      (l) => /^SendMessage \$\d \$\{WM_CLOSE\} 0 0 \/TIMEOUT=15000$/.test(l),
      (l) => l === 'FileOpen $1 "$INSTDIR\\gm-scriptorium-tray.exe" a',
      (l) => l === 'IntCmp $2 20 close_done',
      (l) => l === 'Sleep 250',
      (l) => l === 'Goto close_wait',
    ];
    let at = -1;
    for (const w of want) {
      const next = ls.findIndex((l, i) => i > at && w(l));
      if (next === -1) return false;
      at = next;
    }
    return true;
  };
  assert.equal(inOrder(body), true);
  assert.equal(inOrder(body.split('\n').filter((l) => l.trim() !== 'Sleep 250').join('\n')), false, 'control: a body without the pause is reported');
  assert.deepEqual(
    functionBody(NSI, 'GmRunningLeave').split('\n').map((l) => l.trim()).filter(Boolean),
    ['Call GmNextRestore', 'Call GmCloseTray'],
    'Leave puts the buttons back, then closes the tray app, and does nothing else (#213)',
  );
});

const PAGE_RE = /^(?:!insertmacro\s+MUI_PAGE_\w+|Page\s+custom\b)/;

/** The page list of stage B, in order, as trimmed lines. */
function pageOrder(text) {
  return findLines(text, /^\s*(?:!insertmacro\s+MUI_PAGE_\w+|Page\s+custom\b)/)
    .filter((h) => h.conds.includes('ifndef EXTRACT_UNINSTALLER') && PAGE_RE.test(h.line.trim()))
    .map((h) => h.line.trim());
}

const PAGE_ORDER = [
  '!insertmacro MUI_PAGE_WELCOME',
  '!insertmacro MUI_PAGE_DIRECTORY',
  'Page custom GmOptionsShow GmOptionsLeave',
  'Page custom GmRunningShow GmRunningLeave',
  'Page custom GmSettingsShow',
  'Page custom GmCampaignShow GmCampaignLeave',
  'Page custom GmDetailsShow GmDetailsLeave',
  '!insertmacro MUI_PAGE_INSTFILES',
  'Page custom GmRefusedShow GmRefusedLeave',
  '!insertmacro MUI_PAGE_FINISH',
];

/** The trimmed text of the Section "-Program files" body (to the next SectionEnd). */
function secMainBody(text) {
  const ls = text.split('\n');
  const start = ls.findIndex((l) => l.trim() === 'Section "-Program files" SecMain');
  if (start === -1) return null;
  const end = ls.findIndex((l, i) => i > start && l.trim() === 'SectionEnd');
  return ls.slice(start + 1, end).join('\n');
}

test('order: the pages run in the built order and the running-copy check runs just before the progress page, not on leaving the options', () => {
  assert.deepEqual(pageOrder(NSI), PAGE_ORDER);
  const swapped = PAGE_ORDER.slice();
  [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  assert.notDeepEqual(swapped, PAGE_ORDER);
  assert.notDeepEqual(pageOrder(['!ifndef EXTRACT_UNINSTALLER', ...swapped, '!endif'].join('\n')), PAGE_ORDER);

  const lines = NSI.split('\n').map((l) => l.trim());
  const instfiles = lines.findIndex((l) => l === '!insertmacro MUI_PAGE_INSTFILES');
  let before = instfiles - 1;
  while (before >= 0 && lines[before] === '') before -= 1;
  assert.equal(lines[before], '!define MUI_PAGE_CUSTOMFUNCTION_PRE GmInstallPre');

  const calls = lines.filter((l) => l === 'Call PreInstallChecks');
  assert.equal(calls.length, 2);
  assert.ok(functionBody(NSI, 'GmInstallPre').split('\n').some((l) => l.trim() === 'Call PreInstallChecks'));
  assert.ok(secMainBody(NSI).split('\n').some((l) => l.trim() === 'Call PreInstallChecks'));
  // control: a third call inside the options leave function is seen
  const extra = `${NSI}\nFunction GmOptionsLeave\n  Call PreInstallChecks\nFunctionEnd\n`;
  assert.equal(extra.split('\n').filter((l) => l.trim() === 'Call PreInstallChecks').length, 3);
});

const COPY = [
  'Setup will install ${APP_NAME} $gmWho. You don\'t need administrator permission.$\\r$\\n$\\r$\\n${APP_NAME} turns your gm-apprentice campaign vault into a website for your players. It runs quietly in the background on this PC, with an icon in the system tray, and nothing leaves it unless you publish.$\\r$\\n$\\r$\\nClick Next to continue.',
  '!insertmacro MUI_HEADER_TEXT "Choose Options" "Pick what Setup adds for you."',
  '"Start menu shortcut"',
  '"Find ${APP_NAME} by typing its name in Start."',
  '"Desktop shortcut"',
  '"A shortcut on your desktop."',
  '"Start ${APP_NAME} when I sign in to Windows"',
  '"It starts quietly in the system tray, with no window. Turn it off any time from its icon."',
  '"You\'ll need to start ${APP_NAME} from its folder: $INSTDIR"',
  '"Advanced"',
  '"Add ${APP_NAME} to PATH"',
  '"Lets you type gm-scriptorium in any terminal window, not just the one its tray icon opens. It changes PATH for you only, and the uninstaller takes it out again. Leave it off unless you use the command line."',
  '"Panel port"',
  '"Preview port"',
  '"Change these only if another program already uses them."',
  '"Setup found your settings, so it keeps the ports saved there. Change them later on the panel\'s Overview."',
  '"Type a number from 1 to 65535 for each port, and make the two different."',
  '!insertmacro MUI_HEADER_TEXT "${APP_NAME} is running" "Setup will close it."',
  '"Everything you saved is on disk. If you tick $\\"Start ${APP_NAME} now$\\" at the end, it starts again."',
  '"STR:Close and continue"',
  '!insertmacro MUI_HEADER_TEXT "Your Campaigns" "Setup found your settings and won\'t change them."',
  '"Settings file: $gmConfigPath"',
  '"To add another campaign, use Campaigns in the panel."',
  '!define MUI_FINISHPAGE_TEXT "${APP_NAME} is installed.$\\r$\\n$\\r$\\nIt lives in the system tray, by the clock. Closing your browser doesn\'t stop it; use the icon\'s Quit when you want it off.$\\r$\\n$\\r$\\nClick Finish to close Setup."',
  '!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP_NAME} now"',
  'DetailPrint "Start with Windows couldn\'t be changed. Use Start with Windows in the tray icon\'s menu."',
  'DetailPrint "The ports couldn\'t be saved, so the panel uses 7400 and 7401. Change them later on the panel\'s Overview."',
  '"Setup couldn\'t save ${APP_NAME}\'s tray app, so ${APP_NAME} may not start.$\\r$\\n$\\r$\\nQuit ${APP_NAME} if it is running, then run Setup again."',
  '"Setup didn\'t add ${APP_NAME} to your PATH, because your PATH list is too long to change safely. Nothing was changed.$\\r$\\n$\\r$\\n${APP_NAME} is installed and works as normal. To type gm-scriptorium in a terminal, add $INSTDIR to PATH yourself, or choose Open command line (Advanced) from its icon in the system tray."',
  '"${APP_NAME} is running. Uninstall will close it first."',
  '"The program, its tray helper, and any leftovers from updates$\\r$\\nThe Start menu and desktop shortcuts, if Setup made them$\\r$\\nThe start-with-Windows entry$\\r$\\nThe PATH entry, if Setup added one$\\r$\\nThe Installed apps entry"',
  '!define MUI_FINISHPAGE_TEXT "${APP_NAME} has been removed from your computer. It no longer starts when you sign in.$\\r$\\n$\\r$\\nKept, as always: your settings and campaign list in $gmKept, your campaign vaults and your built sites.$gmFolderNote"',
  '!insertmacro MUI_HEADER_TEXT "Your First Campaign" "Tell ${APP_NAME} where your campaign lives, now or later."',
  '"Set it up in my browser (recommended)"',
  '"A short setup with a preview of each theme. Nothing is written until you review it."',
  '"Answer the questions here now"',
  '"Campaign name, vault and output folder. Title and theme stay in your browser."',
  '"Read the user guide"',
  '!insertmacro MUI_HEADER_TEXT "Campaign Details" "${APP_NAME} checks these itself, once Setup has copied its files."',
  '"You can change the site title and the theme later in the panel."',
  '"Campaign name"',
  '"Lowercase letters, digits and hyphens. Used in commands and folder names."',
  '"Vault"',
  '"I already have a vault"',
  '"Make a new vault, for the game system:"',
  '"For a new vault, choose a new or empty folder."',
  '"Output folder"',
  '"Where your players\' website is built. Must be outside the vault."',
  '"Browse..."',
  '"Choose the vault folder"',
  '"Choose the output folder"',
  '"Fill in the campaign name, the vault folder and the output folder, and choose a game system for a new vault. Double quotes can\'t be used."',
  '"Setting up $gmCampName"',
  '!insertmacro MUI_HEADER_TEXT "Campaign Details" "Fix an answer and try again, or set it up in your browser."',
  '"Setup couldn\'t set up $gmCampName."',
  '"Setup couldn\'t show the reason here."',
  '"Set it up in my browser instead"',
  '"STR:Try again"',
];

test('copy: every user-facing string in the copy table is in installer.nsi exactly as written', () => {
  const missing = COPY.filter((c) => !NSI.includes(c));
  assert.deepEqual(missing, []);
  // control: one character off is not found
  const finish = COPY.find((c) => /by the clock/.test(c));
  assert.ok(finish);
  assert.equal(NSI.includes(finish.replace('by the clock', 'by the clock.')), false);
});

// ---------------------------------------------------------------------------------------------
// Path labels keep an ampersand as typed (SS_NOPREFIX), and the uninstaller finish page layout.
// These are shape tests over the source. They prove nothing about how Windows wraps or draws the
// text; that is the Windows check C213 on the real installer and uninstaller.
// ---------------------------------------------------------------------------------------------

const PATH_LABEL_RE = /^\s*\$\{NSD_CreateLabel\}\s.*\$(?:INSTDIR|APPDATA|gmConfigPath)/;

/**
 * The trimmed label lines whose text shows a user-controlled path and that are not followed by
 * `Pop $X` and then `${NSD_AddStyle} $X ${SS_NOPREFIX}` on the next two lines.
 */
function unstyledPathLabels(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const bad = [];
  lines.forEach((l, i) => {
    if (!PATH_LABEL_RE.test(l)) return;
    const pop = /^Pop (\$\w+)$/.exec(lines[i + 1] || '');
    const ok = pop && lines[i + 2] === `\${NSD_AddStyle} ${pop[1]} \${SS_NOPREFIX}`;
    if (!ok) bad.push(l);
  });
  return bad;
}

test('labels: every label that shows the install folder, the settings folder or the settings file carries SS_NOPREFIX', () => {
  const labels = NSI.split('\n').filter((l) => PATH_LABEL_RE.test(l));
  assert.equal(labels.length, 5, 'the five path labels are all found');
  assert.deepEqual(unstyledPathLabels(NSI), []);
  // controls
  const good = ['${NSD_CreateLabel} 0 0 100% 9u "in $INSTDIR"', 'Pop $0', '${NSD_AddStyle} $0 ${SS_NOPREFIX}'];
  assert.deepEqual(unstyledPathLabels(good.join('\n')), []);
  assert.equal(unstyledPathLabels(good.slice(0, 2).join('\n')).length, 1, 'no AddStyle line');
  assert.equal(unstyledPathLabels([good[0], good[1], '${NSD_AddStyle} $1 ${SS_NOPREFIX}'].join('\n')).length, 1, 'wrong variable');
  assert.equal(unstyledPathLabels(good[0].replace('$INSTDIR', '$APPDATA\\x')).length, 1, 'APPDATA label, nothing after');
  assert.equal(unstyledPathLabels('${NSD_CreateLabel} 0 0 100% 9u "Settings file: $gmConfigPath"').length, 1);
  assert.equal(unstyledPathLabels('${NSD_CreateLabel} 0 0 100% 9u "Removed"').length, 0, 'a label with no path is not in scope');
});

test('labels: the two options-page folder labels are styled right behind their Pop', () => {
  const lines = NSI.split('\n').map((l) => l.trim());
  for (const v of ['$gmLblOff1', '$gmLblOff2']) {
    const i = lines.indexOf(`Pop ${v}`);
    assert.ok(i > 0, `${v} is popped`);
    assert.equal(lines[i + 1], `\${NSD_AddStyle} ${v} \${SS_NOPREFIX}`);
  }
});

test('finish page: the SHOW hook sits between the feedback box defines and the page macro, in stage A', () => {
  const hits = findLines(NSI, /^\s*!define\s+MUI_PAGE_CUSTOMFUNCTION_SHOW\s+un\.GmFinishShow\s*$/);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].conds, ['ifdef EXTRACT_UNINSTALLER']);
  const lines = NSI.split('\n').map((l) => l.trim());
  const notchecked = lines.indexOf('!define MUI_FINISHPAGE_RUN_NOTCHECKED');
  const show = lines.indexOf('!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.GmFinishShow');
  const insert = lines.indexOf('!insertmacro MUI_UNPAGE_FINISH');
  assert.ok(notchecked > 0 && notchecked < show && show < insert);
  // the feedback box stays MUI's
  for (const l of ['!define MUI_FINISHPAGE_RUN', '!define MUI_FINISHPAGE_RUN_FUNCTION un.LaunchFeedback', '!define MUI_FINISHPAGE_TEXT_LARGE']) {
    assert.ok(lines.includes(l), l);
  }
  // the function is defined after the page macro, because MUI declares its variables there
  assert.ok(lines.indexOf('Function un.GmFinishShow') > insert, 'un.GmFinishShow comes after the page macro');
});

const UNFIN_ARITH_BOX = ['IntOp $4 $4 - $8', 'IntOp $5 $5 - $9', 'IntOp $6 $6 - $9'];
const UNFIN_ARITH_TEXT = ['IntOp $8 $0 - $8', 'IntOp $2 $2 - $9', 'IntOp $3 $3 - $9'];
const UNFIN_ARITH_MOVE = [
  'IntOp $0 $5 - $3',
  'IntOp $6 $6 - $5',
  'IntCmp $0 0 finish_done finish_done',
  'IntCmp $6 0 finish_done finish_done',
  'IntOp $7 $7 - $0',
  'IntOp $7 $7 - $6',
  'IntCmp $7 $5 finish_done finish_done',
  'IntOp $3 $7 - $0',
  'IntOp $3 $3 - $2',
];
const UNFIN_STYLE_LINE = '${NSD_AddStyle} $mui.FinishPage.Text ${SS_NOPREFIX}';
const UNFIN_WRAP_LINE = '${NSD_AddStyle} $mui.FinishPage.Text ${SS_EDITCONTROL}';

function unfinBody() {
  const body = functionBody(NSI, 'un.GmFinishShow');
  assert.ok(body, 'un.GmFinishShow exists');
  return body.split('\n').map((l) => l.trim()).filter(Boolean);
}

test('finish page: un.GmFinishShow reads Modern UI\'s own layout in pixels and moves only with the allowed calls, in order', () => {
  const lines = unfinBody();
  const U = UNFIN_LINES;
  const order = [UNFIN_STYLE_LINE, UNFIN_WRAP_LINE, U.alloc, U.origin, U.originRead, U.runRect, U.runRead, U.textRect, U.textRead, U.clientRect, U.clientRead, U.free, U.moveText, U.moveBox];
  const at = order.map((l) => {
    assert.equal(lines.filter((x) => x === l).length, 1, `exactly once in the body: ${l}`);
    return lines.indexOf(l);
  });
  assert.deepEqual(at, at.slice().sort((a, b) => a - b), 'in order');
  // each System line appears once in the whole file, in stage A only
  for (const l of Object.values(U)) {
    const hits = findLines(NSI, new RegExp(`^\\s*${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`));
    assert.equal(hits.length, 1, `once in the file: ${l}`);
    assert.deepEqual(hits[0].conds, ['ifdef EXTRACT_UNINSTALLER'], l);
  }
  // user32 names, in order; no dialog-unit conversion anywhere
  const names = lines.filter((l) => /^System::Call 'user32::/.test(l)).map((l) => /user32::(\w+)/.exec(l)[1]);
  assert.deepEqual(names, ['ClientToScreen', 'GetWindowRect', 'GetWindowRect', 'GetClientRect', 'SetWindowPos', 'SetWindowPos']);
  assert.equal(/MapDialogRect/.test(NSI), false);
  assert.equal(/GM_UNFIN_/.test(NSI), false);
  // controls
  assert.equal(strayPluginLines(`System::Call 'user32::MapDialogRect(p $mui.FinishPage, p r1) i .r0'`).length, 1);
  for (const l of Object.values(U)) assert.equal(strayPluginLines(l).length, 0, l);
});

test('finish page: un.GmFinishShow checks every call and frees the buffer on every path after the allocation', () => {
  const lines = unfinBody();
  const U = UNFIN_LINES;
  const next = (l) => lines[lines.indexOf(l) + 1];
  assert.equal(next(U.alloc), 'IntCmp $1 0 finish_done');
  for (const l of [U.origin, U.runRect, U.textRect, U.clientRect]) assert.equal(next(l), 'IntCmp $0 0 finish_free', l);
  assert.equal(lines[lines.indexOf(U.free) - 1], 'finish_free:');
  assert.equal(next(U.free), 'IntCmp $0 0 finish_done');
  const done = lines.indexOf('finish_done:');
  assert.ok(done > lines.indexOf(U.moveBox) && lines[done + 1] === 'Pop $9', 'finish_done sits between the second SetWindowPos and Pop $9');
  assert.equal(lines.filter((l) => l === 'finish_done:').length, 1);
  assert.equal(lines.filter((l) => l === 'finish_free:').length, 1);
});

test('finish page: the pixel arithmetic is the reviewed listing, in its three places', () => {
  const lines = unfinBody();
  const U = UNFIN_LINES;
  const run = (from, n) => lines.slice(lines.indexOf(from) + 1, lines.indexOf(from) + 1 + n);
  // after the box read, after the text read (a guard comes first there), after the guard that follows the free
  assert.deepEqual(run(U.runRead, 3), UNFIN_ARITH_BOX);
  assert.deepEqual(run(U.textRead, 3), UNFIN_ARITH_TEXT);
  const afterFree = lines.indexOf(U.free) + 2;
  assert.deepEqual(lines.slice(afterFree, afterFree + UNFIN_ARITH_MOVE.length), UNFIN_ARITH_MOVE);
  // the move block is straight before the two SetWindowPos lines
  assert.equal(lines[afterFree + UNFIN_ARITH_MOVE.length], U.moveText);
});

test('finish page: un.GmFinishShow keeps $0 to $9 for its caller', () => {
  const lines = unfinBody();
  const seq = (re) => lines.filter((l) => re.test(l));
  assert.deepEqual(seq(/^Push \$\d$/), ['Push $0', 'Push $1', 'Push $2', 'Push $3', 'Push $4', 'Push $5', 'Push $6', 'Push $7', 'Push $8', 'Push $9']);
  assert.deepEqual(seq(/^Pop \$\d$/), ['Pop $9', 'Pop $8', 'Pop $7', 'Pop $6', 'Pop $5', 'Pop $4', 'Pop $3', 'Pop $2', 'Pop $1', 'Pop $0']);
});

// The uninstaller confirm page (un.ConfirmShow). The path label grows so a path too long for one line
// can break across lines (SS_EDITCONTROL), and the four labels under it move down to make room.
const CONFIRM_LINES = {
  path: '${NSD_CreateLabel} 0 11u 100% 27u "${APP_NAME} will be removed from$\\r$\\n$INSTDIR."',
  removed: '${NSD_CreateLabel} 0 40u 100% 9u "Removed"',
  removedList: '${NSD_CreateLabel} 8u 49u 100% 42u "The program, its tray helper, and any leftovers from updates$\\r$\\nThe Start menu and desktop shortcuts, if Setup made them$\\r$\\nThe start-with-Windows entry$\\r$\\nThe PATH entry, if Setup added one$\\r$\\nThe Installed apps entry"',
  never: '${NSD_CreateLabel} 0 94u 100% 9u "Never touched"',
  keptList: '${NSD_CreateLabel} 8u 103u 100% 28u "Your settings and campaign list, in $APPDATA\\Scriptorium$\\r$\\nYour campaign vaults, including their _meta\\scriptorium\\ folders$\\r$\\nYour built sites, and anything you have published"',
};

test('confirm page: the five labels sit at their pinned positions and the path label is styled for wrapping', () => {
  const lines = functionBody(NSI, 'un.ConfirmShow').split('\n').map((l) => l.trim());
  for (const [k, l] of Object.entries(CONFIRM_LINES)) assert.equal(lines.filter((x) => x === l).length, 1, `exactly once: ${k}`);
  const i = lines.indexOf(CONFIRM_LINES.path);
  assert.deepEqual(lines.slice(i + 1, i + 4), ['Pop $0', '${NSD_AddStyle} $0 ${SS_NOPREFIX}', '${NSD_AddStyle} $0 ${SS_EDITCONTROL}']);
  // order on the page
  const at = Object.values(CONFIRM_LINES).map((l) => lines.indexOf(l));
  assert.deepEqual(at, at.slice().sort((a, b) => a - b));
});

test('confirm page: no label overlaps the next, and the last one ends inside the page', () => {
  // The inner page height is not in any local source. 131u is the bottom the layout was designed to
  // (about 140u is recalled, so 9u spare); the Windows check C213 confirms the last line shows.
  const BOTTOM = 131;
  const geo = (l) => {
    const m = /NSD_CreateLabel\}\s+(?:0|(\d+)u)\s+(\d+)u\s+100%\s+(\d+)u/.exec(l);
    return { top: Number(m[2]), height: Number(m[3]) };
  };
  const g = Object.fromEntries(Object.entries(CONFIRM_LINES).map(([k, l]) => [k, geo(l)]));
  const lines = functionBody(NSI, 'un.ConfirmShow').split('\n').map((l) => l.trim());
  const keys = { path: 'will be removed from', removed: '"Removed"', removedList: 'The program, its tray helper', never: '"Never touched"', keptList: 'Your settings and campaign list' };
  const real = Object.fromEntries(Object.entries(keys).map(([k, t]) => [k, geo(lines.find((x) => x.startsWith('${NSD_CreateLabel}') && x.includes(t)))]));
  assert.deepEqual(real, g, 'the source matches the pinned geometry');
  assert.ok(g.path.top + g.path.height <= g.removed.top, '38 <= 40');
  assert.ok(g.removed.top + g.removed.height <= g.removedList.top, '49 <= 49');
  assert.ok(g.removedList.top + g.removedList.height <= g.never.top, '91 <= 94');
  assert.ok(g.never.top + g.never.height <= g.keptList.top, '103 <= 103');
  assert.ok(g.keptList.top + g.keptList.height <= BOTTOM, 'ends by 131');
  // controls: the old layout overlaps
  assert.equal(11 + 18 <= 31 && 31 + 9 <= 40 && 85 + 9 <= 94, true, 'sanity: old layout was tight but valid');
  assert.equal(11 + 27 <= 31, false, 'a 27u path label at the old Removed position would overlap');
});

// The first campaign: game systems, the one init writer, silent installs, the one exit and the link
// (ADR 0058 section 2)
// ---------------------------------------------------------------------------------------------

test('game systems: STARTER_SYSTEMS is required in stage B only, and is named once, inside GmDetailsFields', () => {
  const guard = findLines(NSI, /^\s*!ifndef\s+STARTER_SYSTEMS\s*$/);
  assert.equal(guard.length, 1);
  assert.ok(guard[0].conds.includes('ifndef EXTRACT_UNINSTALLER'), '!ifndef STARTER_SYSTEMS must sit in stage B');
  const err = findLines(NSI, /^\s*!error\s+"STARTER_SYSTEMS is required in the installer stage"\s*$/);
  assert.equal(err.length, 1);
  assert.ok(err[0].conds.includes('ifndef EXTRACT_UNINSTALLER'));
  assert.ok(err[0].conds.includes('ifndef STARTER_SYSTEMS'));
  const refs = NSI.split('\n').map((l) => l.trim()).filter((l) => /\$\{STARTER_SYSTEMS\}/.test(l));
  assert.deepEqual(refs, ['StrCpy $1 "${STARTER_SYSTEMS}|none"']);
  const body = functionBody(NSI, 'GmDetailsFields');
  assert.ok(body, 'GmDetailsFields is missing');
  assert.equal(body.split('\n').filter((l) => l.trim() === refs[0]).length, 1);
  // controls: a guard outside stage B is reported, and a second reference elsewhere is counted
  const stray = findLines('!ifndef STARTER_SYSTEMS\n!error "x"\n!endif\n', /^\s*!error\b/);
  assert.equal(stray[0].conds.includes('ifndef EXTRACT_UNINSTALLER'), false);
  const twice = `${NSI}\nFunction GmOther\n  StrCpy $2 "\${STARTER_SYSTEMS}"\nFunctionEnd\n`;
  assert.equal(twice.split('\n').filter((l) => /\$\{STARTER_SYSTEMS\}/.test(l)).length, 2);
  assert.equal(functionBody(twice, 'GmDetailsFields').split('\n').filter((l) => /\$\{STARTER_SYSTEMS\}/.test(l)).length, 1);
});

/** The init lines found in `body`, and how many Call GmArgSafe lines come before its first nsExec line. */
function initFacts(body) {
  const lines = body.split('\n').map((l) => l.trim());
  const firstExec = lines.findIndex((l) => /^nsExec::/.test(l));
  return {
    existing: lines.filter((l) => l === COMMAND_LINES[4]).length,
    fresh: lines.filter((l) => l === COMMAND_LINES[5]).length,
    safeBefore: firstExec === -1 ? 0 : lines.slice(0, firstExec).filter((l) => l === 'Call GmArgSafe').length,
  };
}

test('init: both init lines are in GmRunInit after three GmArgSafe calls, and GmRunInit is called only from the first-campaign section and Try again', () => {
  const body = functionBody(NSI, 'GmRunInit');
  assert.ok(body, 'GmRunInit is missing');
  const f = initFacts(body);
  assert.equal(f.existing, 1);
  assert.equal(f.fresh, 1);
  assert.ok(f.safeBefore >= 3, `only ${f.safeBefore} GmArgSafe calls come first`);
  const lines = NSI.split('\n').map((l) => l.trim());
  assert.equal(lines.filter((l) => l === COMMAND_LINES[4]).length, 1, 'the existing-vault line is nowhere else');
  assert.equal(lines.filter((l) => l === COMMAND_LINES[5]).length, 1, 'the new-vault line is nowhere else');
  assert.equal(lines.filter((l) => l === 'Call GmRunInit').length, 2);
  const section = firstCampaignBody(NSI);
  assert.ok(section.some((l) => l === 'Call GmRunInit'));
  assert.ok(functionBody(NSI, 'GmRefusedLeave').split('\n').some((l) => l.trim() === 'Call GmRunInit'));
  // controls: a third call elsewhere is counted, and a body with two GmArgSafe calls is reported
  const extra = `${NSI}\nFunction GmDetailsLeave\n  Call GmRunInit\nFunctionEnd\n`;
  assert.equal(extra.split('\n').filter((l) => l.trim() === 'Call GmRunInit').length, 3);
  const two = body.split('\n');
  two.splice(two.findIndex((l) => l.trim() === 'Call GmArgSafe'), 1);
  assert.equal(initFacts(two.join('\n')).safeBefore, 2);
  assert.equal(initFacts(`${COMMAND_LINES[4]}\n`).safeBefore, 0);
});

/** The trimmed, non-blank lines of Section "-First campaign", to its SectionEnd, or null. */
function firstCampaignBody(text) {
  const ls = text.split('\n').map((l) => l.trim());
  const start = ls.findIndex((l) => l === 'Section "-First campaign"');
  if (start === -1) return null;
  const end = ls.findIndex((l, i) => i > start && l === 'SectionEnd');
  return ls.slice(start + 1, end).filter((l) => l !== '');
}

/** What is wrong with a first-campaign section body, as a list of plain sentences. */
function firstCampaignProblems(body) {
  const out = [];
  if (!body) return ['the section is missing'];
  if (body[0] !== 'SetShellVarContext current') out.push('the first line is not SetShellVarContext current');
  if (body[1] !== 'IfSilent campaign_done') out.push('the second line is not the silent guard');
  if (body[body.length - 1] !== 'campaign_done:') out.push('the last line is not campaign_done:');
  return out;
}

test('silent: the first-campaign section guards on a silent install first, comes after the ports and before Finish, and the answers start empty', () => {
  const body = firstCampaignBody(NSI);
  assert.deepEqual(firstCampaignProblems(body), []);
  const ls = NSI.split('\n').map((l) => l.trim());
  const ports = ls.findIndex((l) => l === 'Section "-Ports"');
  const campaign = ls.findIndex((l) => l === 'Section "-First campaign"');
  const finish = ls.findIndex((l) => l === 'Section "-Finish" SecFinish');
  assert.ok(ports > 0 && campaign > ports && finish > campaign, 'order: ports, then the first campaign, then finish');
  assert.ok(body.some((l) => l === 'StrCmp $gmAskHere 1 0 campaign_done'));
  const defaults = functionBody(NSI, 'GmReadDefaults').split('\n').map((l) => l.trim());
  for (const l of ['StrCpy $gmAskHere 0', 'StrCpy $gmBrowserInstead 0', 'StrCpy $gmInitRc ""']) assert.ok(defaults.some((d) => d === l), l);
  // controls: a body without the silent guard is reported, and so is a section that is not last-labelled
  assert.equal(firstCampaignProblems(body.filter((l) => l !== 'IfSilent campaign_done')).length >= 1, true);
  assert.equal(firstCampaignProblems(body.slice(0, -1)).length >= 1, true);
  assert.deepEqual(firstCampaignProblems(null), ['the section is missing']);
});

/** True when `want` appears in `lines` in this order (not necessarily next to each other). */
function inOrderLines(lines, want) {
  let at = -1;
  for (const w of want) {
    const next = lines.findIndex((l, i) => i > at && l === w);
    if (next === -1) return false;
    at = next;
  }
  return true;
}

test('refused page: one exit, Back and Cancel greyed, Try again on Next, and no skip or later wording', () => {
  assert.equal(NSI.split('"Set it up in my browser instead"').length - 1, 1);
  assert.equal(/Set it up later/i.test(NSI_RAW), false);
  assert.equal(/\bskip\b/i.test(NSI_RAW), false);
  const show = functionBody(NSI, 'GmRefusedShow');
  assert.ok(show, 'GmRefusedShow is missing');
  const lines = show.split('\n').map((l) => l.trim());
  assert.equal(lines.filter((l) => /^SendMessage \$\d \$\{WM_SETTEXT\} 0 "STR:Try again"$/.test(l)).length, 1);
  const GREY = ['GetDlgItem $0 $HWNDPARENT 3', 'EnableWindow $0 0', 'GetDlgItem $0 $HWNDPARENT 2', 'EnableWindow $0 0'];
  assert.equal(inOrderLines(lines, GREY), true);
  // controls on scratch text
  assert.equal(inOrderLines(lines.filter((l, i) => !(l === 'EnableWindow $0 0' && i === lines.lastIndexOf('EnableWindow $0 0'))), GREY), false, 'a body missing the Cancel grey-out is reported');
  assert.equal(inOrderLines(['GetDlgItem $0 $HWNDPARENT 2', 'EnableWindow $0 0', 'GetDlgItem $0 $HWNDPARENT 3', 'EnableWindow $0 0'], GREY), false, 'the wrong order is reported');
  assert.equal(/Set it up later/i.test('${NSD_CreateButton} 0 0 100u 14u "Set it up later in my browser"'), true);
  assert.equal(/\bskip\b/i.test('Skip this step'), true);
  assert.equal(/\bskip\b/i.test('the skipped copy'), false);
  assert.equal('"Set it up in my browser instead" "Set it up in my browser instead"'.split('"Set it up in my browser instead"').length - 1, 2);
  // the two refusal labels are not read for an ampersand
  const styled = lines.filter((l) => /^\$\{NSD_AddStyle\} \$gmLbl(Head|Reason) \$\{SS_NOPREFIX\}$/.test(l));
  assert.equal(styled.length, 2);
});

test('guide link: the documentation address is opened once, in stage B, from GmGuideClicked', () => {
  const hits = findLines(NSI, /^\s*ExecShell\s+"open"\s+"\$\{DOCS_URL\}"\s*$/);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].conds.includes('ifndef EXTRACT_UNINSTALLER'));
  const body = functionBody(NSI, 'GmGuideClicked');
  assert.ok(body, 'GmGuideClicked is missing');
  assert.equal(body.split('\n').filter((l) => l.trim() === DOCS_SHELL_LINE).length, 1);
  // controls: a link opened outside the handler is not in its body
  const outside = `${NSI}\nFunction GmOther\n  ${DOCS_SHELL_LINE}\nFunctionEnd\n`;
  assert.equal(findLines(outside, /^\s*ExecShell\s+"open"\s+"\$\{DOCS_URL\}"\s*$/).length, 2);
});

test('options page: it no longer changes the Next button, because a page always follows it', () => {
  const body = functionBody(NSI, 'GmOptionsShow');
  assert.ok(body, 'GmOptionsShow is missing');
  assert.equal(body.split('\n').filter((l) => /WM_SETTEXT/.test(l)).length, 0);
  // control: the lines main had are seen by the same check
  const old = '  GetDlgItem $0 $HWNDPARENT 1\n  SendMessage $0 ${WM_SETTEXT} 0 "STR:Install"\n';
  assert.equal(old.split('\n').filter((l) => /WM_SETTEXT/.test(l)).length, 1);
});

test('page skips: each new page shows only when it should, by an Abort behind a guard', () => {
  const guards = {
    GmCampaignShow: ['StrCmp $gmHaveSettings 0 +2'],
    GmDetailsShow: ['StrCmp $gmHaveSettings 0 +2', 'StrCmp $gmAskHere 1 +2'],
    GmRefusedShow: ['StrCmp $gmAskHere 1 +2', 'StrCmp $gmInitRc 0 0 +2'],
  };
  for (const [name, want] of Object.entries(guards)) {
    const lines = functionBody(NSI, name).split('\n').map((l) => l.trim());
    for (const g of want) {
      const at = lines.findIndex((l) => l === g);
      assert.ok(at >= 0, `${name} lacks ${g}`);
      assert.equal(lines[at + 1], 'Abort', `${name}: ${g} is not followed by Abort`);
    }
  }
  // control: a guard with no Abort behind it is reported
  const bad = ['StrCmp $gmAskHere 1 +2', 'nsDialogs::Show'];
  assert.notEqual(bad[bad.findIndex((l) => l === 'StrCmp $gmAskHere 1 +2') + 1], 'Abort');
});

// ---------------------------------------------------------------------------------------------
// Issues 213 and 214: the running page's button and the program's refusal line (ADR 0058, addendum)
// ---------------------------------------------------------------------------------------------
// Shape tests only. They pin the source and prove nothing about how Windows draws a button or how
// nsExec decodes a line; that is C217 and C199 step 7 (OPEN on the VM).

function bodyLines(name) {
  const body = functionBody(NSI, name);
  assert.ok(body, `Function ${name} exists`);
  return body.split('\n').map((l) => l.trim()).filter(Boolean);
}

const countInFile = (line) => NSI.split('\n').filter((l) => l.trim() === line).length;

/** Indexes of `needles` in `lines`, each searched after the one before; -1 stops the chain. */
function inOrder(lines, needles) {
  const at = [];
  let from = 0;
  for (const n of needles) {
    const i = lines.indexOf(n, from);
    if (i === -1) return null;
    at.push(i);
    from = i + 1;
  }
  return at;
}

test('I1: the running page widens the button after relabelling it, and puts it back on Back', () => {
  const lines = bodyLines('GmRunningShow');
  const order = [
    'nsDialogs::Create 1018',
    '${NSD_OnBack} GmNextRestore',
    'SendMessage $0 ${WM_SETTEXT} 0 "STR:Close and continue"',
    'Call GmNextFit',
    'nsDialogs::Show',
  ];
  assert.ok(inOrder(lines, order), 'the five lines appear in this order');
  // control: the same lines out of order are not accepted
  assert.equal(inOrder([order[0], order[3], order[2], order[1], order[4]], order), null);
});

test('I2: GmRunningLeave restores first; GmNextFit measures the label, checks each call and frees on every path', () => {
  const leave = bodyLines('GmRunningLeave');
  assert.equal(leave[0], 'Call GmNextRestore');
  assert.equal(leave[1], 'Call GmCloseTray');
  assert.equal(countInFile('Call GmNextFit'), 1);
  assert.equal(countInFile('Call GmNextRestore'), 1);

  const lines = bodyLines('GmNextFit');
  const N = NEXT_FIT_LINES;
  // the label is the owner's text and is eighteen characters; the test types the 18 itself
  assert.equal('Close and continue'.length, 18);
  assert.equal(lines.filter((l) => l.includes('w "Close and continue", i 18,')).length, 1);
  for (const key of Object.keys(N)) {
    if (['putNext', 'putBack'].includes(key)) continue;
    assert.equal(lines.filter((l) => l === N[key]).length, 1, `once in GmNextFit: ${key}`);
    assert.equal(countInFile(N[key]), 1, `once in the file: ${key}`);
  }
  for (const key of ['putNext', 'putBack']) {
    assert.equal(bodyLines('GmNextRestore').filter((l) => l === N[key]).length, 1, key);
    assert.equal(countInFile(N[key]), 1, key);
  }
  // the two move flags: no resize flag on Next, no resize on Back
  assert.ok(N.moveNext.endsWith('i 0x14) i .r8\''));
  assert.ok(N.moveBack.endsWith('i 0x15) i .r8\''));
  // the label is measured first, then the buttons are placed
  assert.ok(inOrder(lines, [N.alloc, N.getDc, N.select, N.extent, N.reselect, N.release, N.sizeRead, N.zero, N.origin, N.originRead, N.nextRect, N.nextRead, N.backRect, N.backRead, N.moveBack, N.moveNext, N.free]));
  // every call's result is looked at
  const next = (l) => lines[lines.indexOf(l) + 1];
  assert.equal(next(N.alloc), 'IntCmp $4 0 fit_done');
  assert.equal(next(N.getDc), 'IntCmp $2 0 fit_free');
  assert.equal(lines[lines.indexOf(N.select) + 2], 'IntCmp $3 0 fit_release');
  assert.equal(lines[lines.indexOf(N.release) + 1], 'IntCmp $5 0 fit_free', 'the measure result is checked after the device context is given back');
  assert.equal(next(N.origin), 'IntCmp $5 0 fit_free');
  assert.equal(next(N.nextRect), 'IntCmp $8 0 fit_free');
  assert.equal(next(N.backRect), 'IntCmp $8 0 fit_free');
  assert.equal(next(N.moveNext), 'IntCmp $8 0 fit_free');
  // Back moves first and the flag is set at once, so Restore always has something to undo and Next never overlaps an unmoved Back
  assert.ok(inOrder(lines, ['IntOp $gmNextX $8 - $5', 'IntOp $gmNextW $2 - $8', 'IntOp $gmBackX $8 - $5', 'IntOp $gmBackY $2 - $6', 'StrCpy $gmNextMoved 1', N.moveBack, 'IntCmp $8 0 fit_free', N.moveNext]), 'originals saved, flag set, Back (0x15), then Next (0x14)');
  assert.equal(countInFile('${NSD_OnBack} GmNextRestore'), 1);
  assert.equal(lines.filter((l) => l === 'StrCpy $gmNextMoved 1').length, 1);
  // the buffer is freed on every path after it exists: the only jump to fit_done is before the allocation is used
  const freeAt = lines.indexOf('fit_free:');
  assert.equal(lines[freeAt + 1], N.free);
  const allocAt = lines.indexOf(N.alloc);
  lines.forEach((l, i) => {
    if (/\bfit_done\b/.test(l) && !/^fit_done:$/.test(l)) assert.ok(i <= allocAt + 1, `a jump to fit_done after the allocation: ${l}`);
  });
  // registers
  const seq = (re) => lines.filter((l) => re.test(l));
  assert.deepEqual(seq(/^Push \$\d$/), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => `Push $${n}`));
  assert.deepEqual(seq(/^Pop \$\d$/), ['9', '8', '7', '6', '5', '4', '3', '2', '1', '0'].map((n) => `Pop $${n}`));
  assert.equal(/MapDialogRect/.test(NSI), false);
});

test('I2: GmNextRestore puts both buttons back only when they were moved, and keeps its registers', () => {
  const lines = bodyLines('GmNextRestore');
  const N = NEXT_FIT_LINES;
  assert.ok(inOrder(lines, ['StrCmp $gmNextMoved 1 +1 restore_done', 'StrCpy $gmNextMoved 0', N.putNext, N.putBack, 'restore_done:']));
  assert.deepEqual(lines.filter((l) => /^Push \$\d$/.test(l)), ['Push $0', 'Push $1', 'Push $2']);
  assert.deepEqual(lines.filter((l) => /^Pop \$\d$/.test(l)), ['Pop $2', 'Pop $1', 'Pop $0']);
});

test('I3: GmFromUtf8 round-trips through the ANSI page strictly, keeps the input on any failure and frees on every path', () => {
  const lines = bodyLines('GmFromUtf8');
  const U = UTF8_LINES;
  assert.ok(U.size.includes('(i 0, i 0x400,'));
  assert.ok(U.toAcp.includes('(i 0, i 0x400,'));
  assert.ok(U.toWide.includes('(i 65001, i 8,'));
  for (const key of Object.keys(U)) {
    assert.equal(lines.filter((l) => l === U[key]).length, 1, `once in GmFromUtf8: ${key}`);
    assert.equal(countInFile(U[key]), 1, `once in the file: ${key}`);
  }
  assert.ok(inOrder(lines, [U.size, 'IntCmp $4 0 utf8_done', U.alloc, 'Pop $3', 'StrCmp $3 0 utf8_done', U.toAcp, 'IntCmp $4 0 utf8_free', 'IntCmp $2 0 +1 utf8_free utf8_free', U.toWide, 'IntCmp $4 0 utf8_free', 'StrCpy $1 $5', 'utf8_free:', U.free, 'utf8_done:']));
  // the input is the default result
  assert.ok(inOrder(lines, ['StrCpy $1 $0', U.size]));
  // after the allocation, the only exits go through the free
  const allocAt = lines.indexOf(U.alloc);
  lines.forEach((l, i) => {
    if (i > allocAt + 2 && /\butf8_done\b/.test(l) && !/^utf8_done:$/.test(l)) assert.fail(`a jump to utf8_done after the allocation: ${l}`);
  });
  // registers: the caller's $0 is swapped out and back, and $1 to $5 are pushed and popped
  assert.equal(lines[0], 'Exch $0');
  assert.equal(lines[lines.length - 1], 'Exch $0');
  assert.deepEqual(lines.filter((l) => /^Push \$\d$/.test(l)), ['Push $1', 'Push $2', 'Push $3', 'Push $4', 'Push $5']);
  assert.deepEqual(lines.slice(lines.indexOf('utf8_done:')).filter((l) => /^Pop \$\d$/.test(l)), ['Pop $5', 'Pop $4', 'Pop $3', 'Pop $2', 'Pop $1']);
});

test('I4: the refusal line is converted once, after the last line is chosen and before the routine ends', () => {
  assert.equal(countInFile('Call GmFromUtf8'), 1);
  const lines = bodyLines('GmRunInit');
  const at = lines.indexOf('Call GmFromUtf8');
  assert.ok(at > 0, 'inside GmRunInit');
  const last = lines.indexOf('init_last:');
  const done = lines.indexOf('init_done:');
  assert.ok(last >= 0 && done > last);
  assert.ok(at > last && at < done, 'between init_last: and init_done:');
  assert.equal(lines[at - 1], 'Push $gmInitLine');
  assert.equal(lines[at + 1], 'Pop $gmInitLine');
  assert.ok(lines.lastIndexOf('StrCpy $gmInitLine $2') < at, 'after the last StrCpy of the line');
});

// Issue 214, second pass. The first fix put the conversion where only a line with no newline after it
// arrives, and the program ends every line with one, so on Windows the conversion never ran. These
// tests run the real GmRunInit text from `init_ran:` to `init_done:` in a small interpreter of the few
// NSIS instructions it uses, with GmFromUtf8 replaced by a stub that marks what it was given. They
// prove the call is reached for the shapes of output the program produces. They do not prove the
// conversion itself (C199 step 7, OPEN on the VM).

/** Runs the scan part of GmRunInit. @returns {{ line: string, converted: string[] }} */
function runInitScan(rc, output) {
  const body = bodyLines('GmRunInit');
  const from = body.indexOf('init_ran:');
  const to = body.indexOf('init_done:');
  assert.ok(from >= 0 && to > from);
  const prog = body.slice(from + 1, to + 1);
  const labels = {};
  const ins = [];
  for (const l of prog) {
    if (/^[A-Za-z_]\w*:$/.test(l)) labels[l.slice(0, -1)] = ins.length;
    else ins.push(l);
  }
  const vars = { gmInitRc: '', gmInitLine: '' };
  const st = [output, String(rc)]; // push order: output first, rc on top
  const converted = [];
  const val = (t) => {
    const s = t.replace(/^"|"$/g, '').replace(/\$\\r/g, '\r').replace(/\$\\n/g, '\n').replace(/\$\{NSIS_MAX_STRLEN\}/g, '1024');
    return s.replace(/\$(\w+)/g, (m, n) => (vars[n] === undefined ? '' : String(vars[n])));
  };
  const toks = (l) => l.match(/"[^"]*"|\S+/g);
  const set = (name, v) => { vars[name.slice(1)] = v; };
  let pc = 0;
  let steps = 0;
  const jump = (label, at) => { pc = /^\+\d+$/.test(label) ? at + Number(label.slice(1)) : labels[label]; assert.notEqual(pc, undefined, label); };
  while (pc < ins.length) {
    assert.ok(++steps < 200000, 'the scan loops forever');
    const at = pc;
    const t = toks(ins[pc]);
    pc++;
    switch (t[0]) {
      case 'Pop': set(t[1], st.pop()); break;
      case 'Push': st.push(val(t[1])); break;
      case 'StrCpy': {
        if (t.length === 4) { const s = val(t[2]); set(t[1], s.substr(Number(val(t[3])), 1)); break; }
        if (t.length === 5) { const s = val(t[2]); set(t[1], s.substr(Number(val(t[4])), Number(val(t[3])))); break; }
        set(t[1], val(t[2]));
        break;
      }
      case 'StrCmp': if (val(t[1]) === val(t[2])) jump(t[3], at); else if (t[4]) jump(t[4], at); break;
      case 'StrLen': set(t[1], val(t[2]).length); break;
      case 'IntOp': set(t[1], t[3] === '+' ? Number(val(t[2])) + Number(val(t[4])) : Number(val(t[2])) - Number(val(t[4]))); break;
      case 'IntCmp': {
        const a = Number(val(t[1])); const b = Number(val(t[2]));
        if (a === b) jump(t[3], at); else if (a < b && t[4]) jump(t[4], at); else if (a > b && t[5]) jump(t[5], at);
        break;
      }
      case 'Goto': jump(t[1], at); break;
      case 'Call': assert.equal(t[1], 'GmFromUtf8'); { const s = st.pop(); converted.push(s); st.push('CONVERTED:' + s); } break;
      case 'StrCmpS': break;
      case 'nsExec::ExecToStack': break;
      default: assert.fail('the interpreter does not know: ' + ins[at]);
    }
  }
  return { line: vars.gmInitLine, converted };
}

test('I5: the refusal line is converted for output that ends in a newline, a CRLF, or nothing, and only then', () => {
  const reason = 'refusing to build inside the vault: C:\\v\\D&D Gr\u00c3\u00bcn\\site';
  for (const tail of ['\n', '\r\n', '']) {
    const r = runInitScan(3, 'first line\n' + reason + tail);
    assert.deepEqual(r.converted, [reason], `converted once, tail ${JSON.stringify(tail)}`);
    assert.equal(r.line, 'CONVERTED:' + reason);
  }
  // a blank line after the reason does not lose it
  assert.equal(runInitScan(3, reason + '\r\n\r\n').line, 'CONVERTED:' + reason);
  // a success is not converted, and an empty output keeps the general line (converted harmlessly, ASCII)
  const ok = runInitScan(0, reason + '\n');
  assert.deepEqual(ok.converted, []);
  assert.equal(ok.line, '');
  const empty = runInitScan(3, '');
  assert.equal(empty.line.replace('CONVERTED:', ''), "Setup couldn't show the reason here.");
  // control: the interpreter does see a call that never happens (output too long to scan keeps the general line)
  const long = runInitScan(3, 'x'.repeat(2000));
  assert.deepEqual(long.converted, []);
  assert.equal(long.line, "Setup couldn't show the reason here.");
});
