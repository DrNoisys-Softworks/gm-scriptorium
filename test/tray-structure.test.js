'use strict';

/*
 * Structure and parity checks on the tray helper's C source (ADR 0057, sections 2 to 7 and
 * "Protocol v1"). The helper only runs on Windows, so these read the source: comments are
 * stripped first (string literals are kept), and every check has a positive control on a small
 * sample, so a scanner that has gone blind cannot pass silently.
 *
 * Expected values are typed here from the ADR and the owner's storyboard, never read from the C.
 * The protocol parity check reads src/desktop/protocol.js on purpose: that module is the other
 * side of the contract, tested on its own in test/desktop-protocol.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const protocol = require('../src/desktop/protocol');

const TRAY_DIR = path.join(__dirname, '..', 'packaging', 'windows', 'tray');
const read = (name) => fs.readFileSync(path.join(TRAY_DIR, name), 'utf8');

/**
 * Removes C comments, keeping string and character literals intact. A "//" inside a string (a URL)
 * is not a comment.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The same text with every string and character literal blanked, for brace and paren counting. */
function blankLiterals(code) {
  return code.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Function definitions: { name, start, end } with start and end as offsets of the body braces. */
function functions(code) {
  const blank = blankLiterals(code);
  const found = [];
  let depth = 0;
  let open = null;
  for (let i = 0; i < blank.length; i++) {
    const c = blank[i];
    if (c === '{') {
      if (depth === 0) {
        const before = blank.slice(Math.max(0, i - 400), i);
        const m = /\b([A-Za-z_]\w*)\s*\(((?:[^()]|\([^()]*\))*)\)\s*$/.exec(before);
        open = { name: m ? m[1] : null, start: i };
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && open) {
        if (open.name) found.push({ name: open.name, start: open.start, end: i });
        open = null;
      }
    }
  }
  return found;
}

/** The name of the function whose body holds `offset`, or null. */
function enclosing(fns, offset) {
  const f = fns.find((x) => offset > x.start && offset < x.end);
  return f ? f.name : null;
}

/** Every call of `name(` with its argument list split at top-level commas. */
function calls(code, name) {
  const blank = blankLiterals(code);
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(blank)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    const args = [];
    let from = i;
    for (; i < blank.length && depth > 0; i++) {
      const c = blank[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if ((c === ',' && depth === 1) || depth === 0) {
        args.push(code.slice(from, i).trim());
        from = i + 1;
      }
    }
    out.push({ offset: m.index, args });
  }
  return out;
}

/** String literal contents (narrow and wide), escapes left as written. */
function literals(code) {
  const out = [];
  const re = /(L?)"((?:\\.|[^"\\\n])*)"/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push({ wide: m[1] === 'L', text: m[2], offset: m.index });
  return out;
}

/** The entries of `static const char *const NAME[] = { ... };` in order, or null. */
function table(code, name) {
  const m = new RegExp(`\\b${name}\\s*\\[\\s*\\w*\\s*\\]\\s*=\\s*\\{([^}]*)\\}`).exec(code);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const lit = /^"((?:\\.|[^"\\])*)"$/.exec(s);
      return lit ? lit[1] : `<not a literal: ${s}>`;
    });
}

const RAW = { 'tray.c': read('tray.c'), 'host.c': read('host.c'), 'tray.h': read('tray.h') };
const CODE = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, stripComments(v)]));
const ALL = Object.values(CODE).join('\n');

// ---------------------------------------------------------------------------------------------
// The scanner itself
// ---------------------------------------------------------------------------------------------

test('positive controls: comments go, strings stay, functions and calls are found', () => {
  const sample = [
    '/* RegSetValueExW in a comment */',
    'static const char *const T[] = { "a", "b?" };',
    '// CreateProcessW( in a line comment',
    'static int one(int (*cb)(int), int x)',
    '{',
    '    const wchar_t *u = L"https://example.invalid/x"; // trailing',
    '    if (x) { CreateProcessW(app, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi); }',
    '    return cb(x);',
    '}',
    'void two(void)',
    '{',
    '    ShellExecuteW(NULL, L"runas", f, NULL, NULL, 1);',
    '    RegSetValueExW(k, L"x", 0, REG_SZ, b, 2);',
    '}',
  ].join('\n');
  const code = stripComments(sample);
  assert.equal(code.includes('RegSetValueExW in a comment'), false);
  assert.equal(code.includes('in a line comment'), false);
  assert.equal(code.includes('L"https://example.invalid/x"'), true, 'a // inside a string is kept');
  assert.equal(code.includes('trailing'), false);
  const fns = functions(code);
  assert.deepEqual(fns.map((f) => f.name), ['one', 'two']);
  const cp = calls(code, 'CreateProcessW');
  assert.equal(cp.length, 1);
  assert.equal(enclosing(fns, cp[0].offset), 'one');
  assert.equal(cp[0].args[0], 'app');
  assert.equal(calls(code, 'ShellExecuteW')[0].args[1], 'L"runas"');
  assert.equal(enclosing(fns, calls(code, 'RegSetValueExW')[0].offset), 'two');
  assert.deepEqual(table(code, 'T'), ['a', 'b?']);
  assert.deepEqual(literals('x = L"a\\"b"; y = "c";').map((l) => [l.wide, l.text]), [[true, 'a\\"b'], [false, 'c']]);
});

// ---------------------------------------------------------------------------------------------
// Things the helper must never do
// ---------------------------------------------------------------------------------------------

const FORBIDDEN = [
  'HKEY_LOCAL_MACHINE',
  'CreateRemoteThread',
  'WriteProcessMemory',
  'VirtualAllocEx',
  'URLDownloadToFile',
  'Internet',
  'WinHttp',
  'WSAStartup',
  'socket(',
  '"runas"',
  'NIF_GUID',
  'HWND_MESSAGE',
  'SearchPathW',
  'ShellExecuteExW',
  'CreateJobObject',
  'TRAY_PURE_ONLY_BUILD_MARKER_NEVER',
];
const FORBIDDEN_ANY_CASE = ['powershell', 'schtasks'];

test('no machine-wide registry, injection, download, network, elevation, NIF_GUID or PATH search', () => {
  for (const [file, code] of Object.entries(CODE)) {
    for (const word of FORBIDDEN) assert.equal(code.includes(word), false, `${file} holds ${word}`);
    for (const word of FORBIDDEN_ANY_CASE) assert.equal(code.toLowerCase().includes(word), false, `${file} holds ${word}`);
  }
});

test('positive control: the forbidden-word scan finds each word in a sample', () => {
  const sample = stripComments('x(HKEY_LOCAL_MACHINE); s = socket(1); ShellExecuteW(0, L"runas"); y(NIF_GUID); z = L"PowerShell"; t(SchTasks);');
  for (const word of ['HKEY_LOCAL_MACHINE', 'socket(', '"runas"', 'NIF_GUID']) assert.equal(sample.includes(word), true, word);
  for (const word of FORBIDDEN_ANY_CASE) assert.equal(sample.toLowerCase().includes(word), true, word);
});

// ---------------------------------------------------------------------------------------------
// Starting programs
// ---------------------------------------------------------------------------------------------

// The four CreateProcessW call sites (Lead amendment 3a), each in its own named function: the
// host, `desktop set`, the command line, and the separate copy `--handoff` starts.
const CREATE_PROCESS_SITES = ['cmd_open', 'desktop_set_run', 'host_spawn', 'self_start'];

function createProcessSites() {
  const out = [];
  for (const [file, code] of Object.entries(CODE)) {
    const fns = functions(code);
    for (const c of calls(code, 'CreateProcessW')) out.push({ file, fn: enclosing(fns, c.offset), args: c.args });
  }
  return out;
}

test('exactly four CreateProcessW call sites, one in each named function', () => {
  const sites = createProcessSites();
  assert.equal(sites.length, 4, JSON.stringify(sites.map((s) => s.fn)));
  assert.deepEqual(sites.map((s) => s.fn).sort(), CREATE_PROCESS_SITES);
  assert.equal(ALL.includes('CreateProcessA'), false);
  assert.equal(/\bShellExecuteA\b|\bWinExec\b|\b_wsystem\b|\bsystem\s*\(|\b_wspawn|\b_wexec/.test(ALL), false);
});

test('every CreateProcessW names its program, so Windows never searches PATH for it', () => {
  for (const s of createProcessSites()) {
    assert.equal(s.args.length, 10, `${s.fn} passes ten arguments`);
    assert.notEqual(s.args[0], 'NULL', `${s.fn} passes an application name`);
    assert.notEqual(s.args[0], '0', `${s.fn} passes an application name`);
  }
});

test('positive control: a fifth CreateProcessW, or one with no application name, is seen', () => {
  const code = stripComments('void extra(void)\n{\n    CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi);\n}\n');
  const c = calls(code, 'CreateProcessW');
  assert.equal(c.length, 1);
  assert.equal(enclosing(functions(code), c[0].offset), 'extra');
  assert.equal(c[0].args[0], 'NULL');
});

test('the host gets DETACHED_PROCESS, a new process group and a Unicode environment, never CREATE_NO_WINDOW', () => {
  const host = CODE['host.c'];
  const fn = functions(host).find((f) => f.name === 'host_spawn');
  assert.ok(fn, 'host_spawn exists');
  const body = host.slice(fn.start, fn.end);
  for (const flag of ['DETACHED_PROCESS', 'CREATE_NEW_PROCESS_GROUP', 'CREATE_UNICODE_ENVIRONMENT']) assert.equal(body.includes(flag), true, flag);
  assert.equal(body.includes('CREATE_NO_WINDOW'), false);
  // CREATE_NO_WINDOW appears once, for `desktop set` only.
  const uses = [];
  for (const [, code] of Object.entries(CODE)) {
    const fns = functions(code);
    let i = code.indexOf('CREATE_NO_WINDOW');
    while (i >= 0) {
      uses.push(enclosing(fns, i));
      i = code.indexOf('CREATE_NO_WINDOW', i + 1);
    }
  }
  assert.deepEqual(uses, ['desktop_set_run']);
});

test('the host and desktop set are found beside the helper through GetModuleFileNameW', () => {
  assert.equal(ALL.includes('GetModuleFileNameW'), true);
  assert.equal(literals(ALL).some((l) => l.wide && l.text === '\\\\gm-scriptorium.exe'), true);
  assert.equal(literals(ALL).some((l) => l.wide && l.text === ' desktop run'), true);
  assert.equal(literals(ALL).some((l) => l.wide && l.text === ' --background'), true);
  assert.equal(literals(ALL).some((l) => l.wide && l.text === ' desktop set --port '), true);
  assert.equal(literals(ALL).some((l) => l.wide && l.text === ' --preview-port '), true);
});

test('the command line is cmd.exe from the system folder with the exact banner', () => {
  const tray = CODE['tray.c'];
  assert.equal(tray.includes('GetSystemDirectoryW'), true);
  assert.equal(literals(tray).some((l) => l.wide && l.text === '\\\\cmd.exe'), true);
  // The arguments are the head, the app version, then the tail (ADR 0057 section 10). Written as
  // the C source spells them, so \" is a quote inside the literal.
  const wide = literals(tray).filter((l) => l.wide).map((l) => l.text);
  assert.equal(wide.includes(' /d /s /k \\"title GM-Scriptorium command line & echo GM-Scriptorium '), true, 'head');
  assert.equal(
    wide.includes(
      ' command line & echo GM-Scriptorium keeps running in the background. Commands here work alongside it. & echo Try gm-scriptorium status, gm-scriptorium check or gm-scriptorium --help.\\"',
    ),
    true,
    'tail',
  );
  const fn = functions(tray).find((f) => f.name === 'cmd_open');
  assert.ok(fn, 'cmd_open exists');
  assert.match(tray.slice(fn.start, fn.end), /CMD_ARGS_HEAD[\s\S]*TRAY_APP_VERSION_W[\s\S]*CMD_ARGS_TAIL/);
  const body = tray.slice(fn.start, fn.end);
  assert.equal(body.includes('CREATE_NEW_CONSOLE'), true);
  assert.equal(body.includes('CREATE_UNICODE_ENVIRONMENT'), true);
});

test('every ShellExecuteW uses L"open"', () => {
  const sites = [];
  for (const code of Object.values(CODE)) for (const c of calls(code, 'ShellExecuteW')) sites.push(c.args[1]);
  assert.ok(sites.length >= 2, 'the log folder and the patch notes');
  for (const verb of sites) assert.equal(verb, 'L"open"');
});

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

function sitesOf(name) {
  const out = [];
  for (const code of Object.values(CODE)) {
    const fns = functions(code);
    for (const c of calls(code, name)) out.push(enclosing(fns, c.offset));
  }
  return out;
}

test('RegSetValueExW appears only inside autostart_set and toast_state_set', () => {
  const sites = sitesOf('RegSetValueExW');
  assert.ok(sites.length >= 2);
  for (const fn of sites) assert.ok(['autostart_set', 'toast_state_set'].includes(fn), String(fn));
  assert.equal(/\bRegSetValueW\b|\bRegSetKeyValueW\b|\bRegSetValueExA\b|\bSHSetValue/.test(ALL), false);
});

test('values are deleted and keys created only by those two functions too', () => {
  for (const fn of sitesOf('RegDeleteValueW')) assert.equal(fn, 'autostart_set');
  for (const fn of sitesOf('RegCreateKeyExW')) assert.ok(['autostart_set', 'toast_state_set'].includes(fn), String(fn));
  assert.equal(/\bRegDeleteKey|\bRegDeleteTree|\bSHDelete/.test(ALL), false);
});

test('positive control: a RegSetValueExW outside the two functions is named', () => {
  const code = stripComments('static void sneaky(HKEY k)\n{\n    RegSetValueExW(k, L"x", 0, REG_SZ, 0, 0);\n}\n');
  const fns = functions(code);
  assert.equal(enclosing(fns, calls(code, 'RegSetValueExW')[0].offset), 'sneaky');
});

test('the registry names are exact', () => {
  const wide = literals(ALL).filter((l) => l.wide).map((l) => l.text);
  for (const want of [
    'Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run',
    'Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\StartupApproved\\\\Run',
    'GM-Scriptorium',
    'Software\\\\GM-Scriptorium\\\\Tray',
    'FirstRunToast',
    'UpdateToast',
    '\\" --background',
  ]) {
    assert.equal(wide.includes(want), true, want);
  }
  assert.equal(ALL.includes('HKEY_CURRENT_USER'), true);
  assert.match(CODE['tray.c'], /0x03\b/, 'StartupApproved counts as disabled when its first byte is 0x03');
});

// ---------------------------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------------------------

test('the window class literal is defined exactly once, as a #define in tray.h', () => {
  let count = 0;
  for (const raw of Object.values(RAW)) count += raw.split('GMScriptoriumTray').length - 1;
  assert.equal(count, 1);
  assert.match(CODE['tray.h'], /^#define TRAY_WINDOW_CLASS L"GMScriptoriumTray"$/m);
});

test('mutex, copy-data tag and payloads are exact', () => {
  const wide = literals(ALL).filter((l) => l.wide).map((l) => l.text);
  assert.equal(wide.includes('Local\\\\GM-Scriptorium-tray'), true);
  assert.equal(wide.includes('open'), true);
  assert.equal(wide.includes('handoff'), true);
  assert.match(ALL, /0x47534354/);
  assert.equal(ALL.includes('WM_QUERYENDSESSION'), true);
  assert.equal(ALL.includes('WM_ENDSESSION'), true);
  assert.equal(ALL.includes('TaskbarCreated'), true);
  assert.match(CODE['tray.h'], /#define TRAY_ENDSESSION_WAIT_MS 4000\b/);
});

// ---------------------------------------------------------------------------------------------
// Protocol parity with src/desktop/protocol.js
// ---------------------------------------------------------------------------------------------

test('protocol parity: the verb tables in host.c equal HOST_VERBS and HELPER_VERBS, in order', () => {
  assert.deepEqual(table(CODE['host.c'], 'HOST_VERBS'), [...protocol.HOST_VERBS]);
  assert.deepEqual(table(CODE['host.c'], 'HELPER_VERBS'), [...protocol.HELPER_VERBS]);
});

test('protocol parity: every verb is a string literal in host.c, once, inside its table, and nowhere else', () => {
  const host = CODE['host.c'];
  const lits = literals(host).filter((l) => !l.wide);
  const verbs = [...protocol.HOST_VERBS, ...protocol.HELPER_VERBS];
  for (const verb of verbs) {
    assert.equal(lits.filter((l) => l.text === verb).length, 1, `"${verb}" once in host.c`);
  }
  for (const file of ['tray.c', 'tray.h']) {
    for (const l of literals(CODE[file]).filter((x) => !x.wide)) {
      assert.equal(verbs.includes(l.text), false, `${file} spells out the verb "${l.text}"; use the table`);
    }
  }
});

test('protocol parity: the version and the line limit', () => {
  assert.match(CODE['tray.h'], new RegExp(`^#define TRAY_PROTOCOL_VERSION ${protocol.PROTOCOL_VERSION}$`, 'm'));
  assert.match(CODE['tray.h'], new RegExp(`^#define TRAY_MAX_LINE_BYTES ${protocol.MAX_LINE_BYTES}$`, 'm'));
  // Typed from the ADR as well, so a change on both sides at once still goes red here.
  assert.equal(protocol.PROTOCOL_VERSION, 1);
  assert.equal(protocol.MAX_LINE_BYTES, 1024);
});

test('positive control: a renamed or extra verb on either side breaks the table comparison', () => {
  const renamed = 'static const char *const HELPER_VERBS[] = { "open", "stop?", "stop", "start", "restart", "retry", "quit?", "exit" };';
  assert.notDeepEqual(table(renamed, 'HELPER_VERBS'), [...protocol.HELPER_VERBS]);
  const extra = 'static const char *const HOST_VERBS[] = { "hello", "state", "confirm", "update", "bye", "ping" };';
  assert.notDeepEqual(table(extra, 'HOST_VERBS'), [...protocol.HOST_VERBS]);
  assert.equal(table('nothing here', 'HOST_VERBS'), null);
});

// ---------------------------------------------------------------------------------------------
// The words the GM sees (storyboard frames T01 to T10 and N01 to N05, owner notes and rulings)
// ---------------------------------------------------------------------------------------------

const MENU_LABELS = [
  'Open panel',
  'Open preview',
  'Only you can see it. Not your published site.',
  'Stop panel',
  'Start panel',
  'Restart',
  'Check for updates',
  'Update available: ',
  'Start with Windows',
  'Remote access is on, including at sign-in.',
  'Remote access is set up. At sign-in it starts on this PC only until you confirm.',
  'Open command line (Advanced)',
  'Open log folder',
  'Quit GM-Scriptorium',
  'Try again',
  'Change ports...',
  'This PC only',
  'Nothing is listening. Start it again here.',
  "Can't reach your vault",
  ' is in use by another program',
  "The panel can't start on it.",
  'Remote access is off at sign-in. Start it from the tray to turn it on.',
  'Quit GM-Scriptorium and start it again from the Start menu to finish updating.',
  'GM-Scriptorium: running, ',
  'GM-Scriptorium: panel stopped, ',
];

const TOAST_TEXT = [
  'GM-Scriptorium is running',
  "Find its icon in the system tray, by the clock. Closing your browser doesn't stop GM-Scriptorium.",
  "GM-Scriptorium couldn't start",
  ' Click to try again.',
  ' is available',
  '. Click to view the patch notes.',
  'You have ',
  '. Click to change ports.',
];

const CONFIRM_TEXT = [
  'Quit GM-Scriptorium?',
  'Remote access is on. Quitting signs out anyone using the panel from another device, and turns off your preview.',
  "A preview build is running. Quitting stops it partway; your vault isn't changed.",
];

test('menu, tooltip, toast and confirm wording is exact', () => {
  const wide = literals(CODE['tray.c']).filter((l) => l.wide).map((l) => l.text.replace(/\\'/g, "'"));
  for (const want of [...MENU_LABELS, ...TOAST_TEXT, ...CONFIRM_TEXT]) {
    assert.equal(wide.includes(want), true, want);
  }
});

test('owner note 4: "system tray", never the ^ hint or "notification area" in anything the GM reads', () => {
  for (const l of literals(CODE['tray.c']).filter((x) => x.wide)) {
    assert.equal(l.text.includes('click ^'), false, l.text);
    assert.equal(/notification area/i.test(l.text), false, l.text);
  }
});

test('the patch-notes address is opened only through notes_url_ok', () => {
  const tray = CODE['tray.c'];
  assert.match(CODE['host.c'], /"https:\/\/github\.com\/DrNoisys-Softworks\/gm-scriptorium\/releases\/tag\/v"/);
  const fns = functions(tray);
  const opens = calls(tray, 'ShellExecuteW').map((c) => enclosing(fns, c.offset)).sort();
  assert.deepEqual(opens, ['open_log_folder', 'open_notes']);
  const fn = fns.find((f) => f.name === 'open_notes');
  assert.match(tray.slice(fn.start, fn.end), /notes_url_ok\s*\(/);
});

test('the confirms are TaskDialogIndirect with Cancel as the default button', () => {
  const tray = CODE['tray.c'];
  assert.equal(tray.includes('TaskDialogIndirect'), true);
  assert.match(tray, /nDefaultButton\s*=\s*IDCANCEL/);
  assert.equal(/\bMessageBox[AW]?\s*\(/.test(tray), false);
});

test('toasts are balloons with the Lantern, and the icon comes from its own resources', () => {
  const tray = CODE['tray.c'];
  for (const word of ['NIF_INFO', 'NIIF_USER', 'NIIF_LARGE_ICON', 'NIN_BALLOONUSERCLICK', 'LoadIconMetric', 'LIM_SMALL', 'NOTIFYICON_VERSION_4']) {
    assert.equal(tray.includes(word), true, word);
  }
});

test('the ports window checks both fields with port_field_ok before any command line is built', () => {
  const host = CODE['host.c'];
  const fn = functions(host).find((f) => f.name === 'desktop_set_run');
  const body = host.slice(fn.start, fn.end);
  const check = body.indexOf('port_field_ok(');
  const build = body.indexOf('desktop set --port');
  assert.ok(check > 0 && build > check, 'the digit check comes before the command line');
});

test('the stderr ring is drained and discarded: never written anywhere', () => {
  const host = CODE['host.c'];
  const fn = functions(host).find((f) => f.name === 'stderr_drain_main');
  assert.ok(fn, 'stderr_drain_main exists');
  const body = host.slice(fn.start, fn.end);
  assert.match(body, /ReadFile\s*\(/);
  for (const word of ['WriteFile', 'Reg', 'Shell_NotifyIcon', 'PostMessage', 'SendMessage', 'printf', 'fopen', 'CreateFile']) {
    assert.equal(body.includes(word), false, word);
  }
});

// ---------------------------------------------------------------------------------------------
// Owner ruling RV1: the sign-in local-only marker (ADR 0057 section 7 and "Protocol v1")
// ---------------------------------------------------------------------------------------------

const SIGNIN_LOCAL = 'signin-local';

/** The body of the `"running"` branch of on_state, or null. */
function runningBranch(code) {
  const fn = functions(code).find((f) => f.name === 'on_state');
  if (!fn) return null;
  const body = code.slice(fn.start, fn.end);
  const start = body.indexOf('strcmp(what, "running") == 0');
  if (start < 0) return null;
  const next = body.indexOf('} else if', start);
  return body.slice(start, next < 0 ? body.length : next);
}

/** True when the branch compares the fifth field (args index 4) with the marker. */
function readsMarkerFromFifthField(branch, marker) {
  return new RegExp(`strcmp\\(\\s*arg\\(\\s*pl\\s*,\\s*4\\s*\\)\\s*,\\s*"${marker}"\\s*\\)\\s*==\\s*0`).test(branch);
}

test('RV1: tray.c holds "signin-local" exactly once, read from the fifth field of state running', () => {
  const tray = CODE['tray.c'];
  assert.equal(literals(tray).filter((l) => !l.wide && l.text === SIGNIN_LOCAL).length, 1);
  const branch = runningBranch(tray);
  assert.ok(branch, 'on_state has a "running" branch');
  assert.equal(readsMarkerFromFifthField(branch, SIGNIN_LOCAL), true);
  assert.match(branch, /g\.signin_local\s*=/);
  for (const file of ['host.c', 'tray.h']) {
    assert.equal(literals(CODE[file]).some((l) => l.text === SIGNIN_LOCAL), false, file);
  }
});

test('RV1: ADR 0057 names the field exactly as pinned, in section 7 and in the state running line', () => {
  const adr = fs.readFileSync(path.join(__dirname, '..', 'docs', 'decisions', '0057-windows-desktop-app.md'), 'utf8');
  const s7 = adr.slice(adr.indexOf('## 7. Start with Windows'), adr.indexOf('## 8. Fixed ports'));
  assert.ok(s7.length > 0);
  assert.equal(s7.includes(`\`${SIGNIN_LOCAL}\``), true, 'section 7 names the field');
  assert.match(s7, /optional last field of its `state running` line/);
  // The Protocol v1 line as the host's side of the decision wrote it, with the signin= field last.
  assert.equal(adr.includes(`\`state  running  <campaign or setup>  <reach>  <address>  [${SIGNIN_LOCAL}]  signin=confirmed|signin=unconfirmed\``), true, 'Protocol v1 line');
});

test('positive control: a renamed marker or the wrong field is seen', () => {
  const good = 'static void on_state(const struct proto_line *pl)\n{\n    if (strcmp(what, "running") == 0) {\n        g.signin_local = strcmp(arg(pl, 4), "signin-local") == 0;\n    } else if (x) {\n        y();\n    }\n}\n';
  assert.equal(readsMarkerFromFifthField(runningBranch(stripComments(good)), SIGNIN_LOCAL), true);
  const renamed = good.replace('"signin-local"', '"signin-only"');
  assert.equal(readsMarkerFromFifthField(runningBranch(stripComments(renamed)), SIGNIN_LOCAL), false);
  assert.equal(literals(stripComments(renamed)).filter((l) => l.text === SIGNIN_LOCAL).length, 0);
  const wrongField = good.replace('arg(pl, 4)', 'arg(pl, 3)');
  assert.equal(readsMarkerFromFifthField(runningBranch(stripComments(wrongField)), SIGNIN_LOCAL), false);
  const elsewhere = good.replace('    } else if (x) {\n        y();', '    } else if (x) {\n        g.signin_local = strcmp(arg(pl, 4), "signin-local") == 0;').replace('        g.signin_local = strcmp(arg(pl, 4), "signin-local") == 0;\n    } else', '        z();\n    } else');
  assert.equal(readsMarkerFromFifthField(runningBranch(stripComments(elsewhere)), SIGNIN_LOCAL), false);
});

// ---------------------------------------------------------------------------------------------
// Owner ruling T03 ("two-lines"): the line under Start with Windows when remote access is on
// ---------------------------------------------------------------------------------------------

const T03_CONFIRMED = 'Remote access is on, including at sign-in.';
const T03_UNCONFIRMED = 'Remote access is set up. At sign-in it starts on this PC only until you confirm.';

/** The body of build_menu, or ''. */
function buildMenuBody(code) {
  const fn = functions(code).find((f) => f.name === 'build_menu');
  return fn ? code.slice(fn.start, fn.end) : '';
}

/**
 * The T03 line is chosen by t03_line() in host.c (unit-tested natively in tray-build) from Start with
 * Windows, the signin-local marker, a remote reach and the signin= field. build_menu must pass exactly
 * those four and map each answer to its own string, once each.
 */
function t03Ok(code) {
  const body = blankLiterals(buildMenuBody(code));
  const count = (s) => body.split(s).length - 1;
  return (
    count('const int t03 = t03_line(autostart, g.signin_local, remote_on(), g.signin_confirmed);') === 1 &&
    count('if (t03 == T03_UNCONFIRMED) add_item(m, IDM_INERT, T03_UNCONFIRMED_TEXT, 0);') === 1 &&
    count('else if (t03 == T03_CONFIRMED) add_item(m, IDM_INERT, T03_CONFIRMED_TEXT, 0);') === 1 &&
    count('T03_UNCONFIRMED_TEXT') === 1 &&
    count('T03_CONFIRMED_TEXT') === 1
  );
}

test('T03: the two ruled lines are defined once each, word for word, and the old line is gone', () => {
  const tray = CODE['tray.c'];
  const wide = literals(tray).filter((l) => l.wide).map((l) => l.text);
  assert.equal(wide.filter((t) => t === T03_CONFIRMED).length, 1);
  assert.equal(wide.filter((t) => t === T03_UNCONFIRMED).length, 1);
  assert.match(tray, /static const wchar_t T03_CONFIRMED_TEXT\[\] = L"Remote access is on, including at sign-in\.";/);
  assert.match(tray, /static const wchar_t T03_UNCONFIRMED_TEXT\[\] = L"Remote access is set up\. At sign-in it starts on this PC only until you confirm\.";/);
  assert.equal(tray.includes('so it also listens for other devices from sign-in'), false);
  assert.equal(tray.includes('Remote access is on. At sign-in'), false, 'the T03 wording before the T03b ruling is gone');
});

test('T03: build_menu asks t03_line with Start with Windows, signin-local, the remote reach and signin=, and shows its answer', () => {
  assert.equal(t03Ok(CODE['tray.c']), true);
});

test('signin= is read on every running line through signin_confirmed, and only host.c spells the field', () => {
  const branch = runningBranch(CODE['tray.c']);
  assert.match(branch, /g\.signin_confirmed\s*=\s*signin_confirmed\(\s*\(const char \*const \*\)pl->args\s*,\s*pl->nargs < TRAY_MAX_FIELDS \? pl->nargs : TRAY_MAX_FIELDS\s*\)\s*;/);
  const hostLits = literals(CODE['host.c']).filter((l) => !l.wide).map((l) => l.text);
  assert.equal(hostLits.filter((t) => t === 'signin=confirmed').length, 1);
  for (const file of ['tray.c', 'tray.h']) {
    assert.equal(literals(CODE[file]).some((l) => l.text.startsWith('signin=')), false, file);
  }
});

/** The body of the `"starting"` branch of on_state, or null. */
function startingBranch(code) {
  const fn = functions(code).find((f) => f.name === 'on_state');
  if (!fn) return null;
  const body = code.slice(fn.start, fn.end);
  const start = body.indexOf('strcmp(what, "starting") == 0');
  if (start < 0) return null;
  const next = body.indexOf('} else if', start);
  return body.slice(start, next < 0 ? body.length : next);
}

function resets(text) {
  return /g\.signin_local\s*=\s*0\s*;/.test(text) && /g\.signin_confirmed\s*=\s*0\s*;/.test(text);
}

test('a starting state (Restart, Start panel, a retry) forgets the sign-in markers until the next running line', () => {
  assert.equal(resets(startingBranch(CODE['tray.c'])), true, 'on_state "starting"');
  const fn = functions(CODE['tray.c']).find((f) => f.name === 'do_retry');
  assert.equal(resets(CODE['tray.c'].slice(fn.start, fn.end)), true, 'do_retry, which starts a new host');
});

test('positive control: a swapped mapping, a dropped input, a missing read or a missing reset is seen', () => {
  const good = [
    'static HMENU build_menu(void)',
    '{',
    '        const int t03 = t03_line(autostart, g.signin_local, remote_on(), g.signin_confirmed);',
    '        if (t03 == T03_UNCONFIRMED) add_item(m, IDM_INERT, T03_UNCONFIRMED_TEXT, 0);',
    '        else if (t03 == T03_CONFIRMED) add_item(m, IDM_INERT, T03_CONFIRMED_TEXT, 0);',
    '}',
    '',
  ].join('\n');
  assert.equal(t03Ok(stripComments(good)), true);
  const swapped = good.replace('(t03 == T03_UNCONFIRMED)', '(t03 == T03_X)').replace('(t03 == T03_CONFIRMED)', '(t03 == T03_UNCONFIRMED)').replace('T03_X', 'T03_CONFIRMED');
  assert.equal(t03Ok(stripComments(swapped)), false);
  assert.equal(t03Ok(stripComments(good.replace('remote_on(), g.signin_confirmed)', 'remote_on(), 1)'))), false);
  assert.equal(t03Ok(stripComments(good.replace('t03_line(autostart,', 't03_line(1,'))), false);
  const state = [
    'static void on_state(const struct proto_line *pl)',
    '{',
    '    if (strcmp(what, "starting") == 0) {',
    '        g.signin_local = 0;',
    '        g.signin_confirmed = 0;',
    '    } else if (strcmp(what, "running") == 0) {',
    '        g.signin_confirmed = signin_confirmed((const char *const *)pl->args, pl->nargs < TRAY_MAX_FIELDS ? pl->nargs : TRAY_MAX_FIELDS);',
    '    } else if (x) {',
    '    }',
    '}',
    '',
  ].join('\n');
  assert.equal(resets(startingBranch(stripComments(state))), true);
  assert.equal(resets(startingBranch(stripComments(state.replace('        g.signin_confirmed = 0;\n', '')))), false);
  assert.match(runningBranch(stripComments(state)), /g\.signin_confirmed\s*=\s*signin_confirmed\(/);
  assert.doesNotMatch(runningBranch(stripComments(state.replace('signin_confirmed((const', 'keep((const'))), /g\.signin_confirmed\s*=\s*signin_confirmed\(/);
});
