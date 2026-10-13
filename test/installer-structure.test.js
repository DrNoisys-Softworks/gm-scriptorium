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

test('required: every PATH write is inside !ifdef WITH_PATH_OPTION, together with RegGetValueW', () => {
  const writes = findLines(NSI, /^\s*(?:WriteReg\w+|DeleteRegValue|DeleteRegKey)\s+HKCU\s+"Environment"/);
  assert.ok(writes.length >= 2, 'expected the installer add and the uninstaller remove');
  for (const w of writes) assert.ok(w.conds.includes('ifdef WITH_PATH_OPTION'), `line ${w.n} writes PATH outside WITH_PATH_OPTION`);
  const reads = findLines(NSI, /RegGetValueW/);
  assert.ok(reads.length >= 1, 'RegGetValueW is the size and type read that guards every PATH write');
  for (const r of reads) assert.ok(r.conds.includes('ifdef WITH_PATH_OPTION'), `line ${r.n} reads PATH outside WITH_PATH_OPTION`);
  // controls
  const bad = findLines('WriteRegExpandStr HKCU "Environment" "Path" "x"\n', /^\s*(?:WriteReg\w+|DeleteRegValue|DeleteRegKey)\s+HKCU\s+"Environment"/);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].conds.includes('ifdef WITH_PATH_OPTION'), false);
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

test('required: the shortcuts and the finish run start the exe with no arguments', () => {
  assert.equal(findLines(NSI, /MUI_FINISHPAGE_RUN_PARAMETERS/).length, 0);
  const shortcuts = findLines(NSI, /^\s*CreateShortCut\b/);
  assert.equal(shortcuts.length, 2, 'Start menu and Desktop');
  for (const s of shortcuts) {
    assert.match(s.line, /CreateShortCut\s+"\$(?:SMPROGRAMS|DESKTOP)\\GM-Scriptorium\.lnk"\s+"\$INSTDIR\\gm-scriptorium\.exe"\s+""\s+"\$INSTDIR\\gm-scriptorium\.exe"\s+0\s*$/);
  }
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
  for (const name of ['VERSION', 'VERSION4', 'OUTFILE', 'EXTRACT_UNINSTALLER', 'UNINSTALLER_OUT', 'EXE_IN', 'UNINSTALLER_IN', 'NOTICES_IN', 'WITH_PATH_OPTION']) {
    assert.match(NSI, new RegExp(`\\b${name}\\b`), name);
  }
});
