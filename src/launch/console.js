'use strict';

/*
 * ADR 0028, section 6. The launch-mode console: its text, and the raw-key handling behind "Press O
 * to open it again" and Ctrl+C. Pure apart from the input stream it is handed, so tests drive both
 * with fake streams.
 */

const CTRL_C = '\u0003';
const ESCAPE = '\u001b';

/**
 * The console text, in the mock's order. The apostrophe in the last line is U+2019, as in the mock.
 * The long-lived token is never part of it (the fallback line after a failed open is printed by the
 * caller, and only then).
 *
 * @param {{ version: string, port: number, setupMode: boolean, campaign?: string|null, remoteLines?: string[] }} info
 *   remoteLines: the extra address lines of a remote mode (src/remote/settings.js remoteAddressLines);
 *   empty for local mode, where the panel is reachable from this PC only.
 * @returns {string[]}
 */
function launchLines({ version, port, setupMode, campaign = null, remoteLines = [] }) {
  const remote = remoteLines.length > 0;
  const lines = [
    `GM-Scriptorium ${version}`,
    '',
    'GM-Scriptorium is running. Your panel is open in your browser.',
    'Close this window to stop.',
    '',
    `  Panel    http://127.0.0.1:${port}   ${remote ? 'on this machine' : 'this PC only'}`,
  ];
  for (const line of remoteLines) lines.push(`  ${line}`);
  lines.push(setupMode ? '  Setup    no campaign yet, so the panel starts with setup' : `  Campaign ${campaign}`);
  lines.push('', 'Browser didn’t open? Press O to open it again.');
  return lines;
}

/**
 * Raw single-key handling: O or o calls onOpen, Ctrl+C (byte 0x03, which raw mode delivers as data
 * instead of a SIGINT) calls onStop, everything else is ignored. A chunk that starts with an escape
 * (an arrow or function key) is ignored whole, so the "O" inside ESC O A never opens anything.
 *
 * @param {NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown }} input
 * @param {{ onOpen: () => void, onStop: () => void }} handlers
 * @returns {() => void} detach: removes the listener, turns raw mode off and pauses the stream
 */
function attachKeys(input, { onOpen, onStop }) {
  const canRaw = typeof input.setRawMode === 'function';
  if (canRaw) input.setRawMode(true);
  const onData = (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
    if (text.startsWith(ESCAPE)) return;
    for (const ch of text) {
      if (ch === CTRL_C) {
        onStop();
        return;
      }
      if (ch === 'o' || ch === 'O') onOpen();
    }
  };
  input.on('data', onData);
  if (typeof input.resume === 'function') input.resume();
  let detached = false;
  return function detach() {
    if (detached) return;
    detached = true;
    input.removeListener('data', onData);
    if (canRaw) {
      try {
        input.setRawMode(false);
      } catch {
        // a console that is already gone has nothing to restore
      }
    }
    if (typeof input.pause === 'function') input.pause();
  };
}

module.exports = { launchLines, attachKeys };
