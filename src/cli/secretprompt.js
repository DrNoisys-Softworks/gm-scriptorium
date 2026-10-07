'use strict';

const { createPrompter } = require('./prompt');

/*
 * V1.5a (docs/decisions/0029-remote-access.md section 6; SD-doc section 13): reading a secret from
 * a person. Never from argv or the environment (a command line is visible in `ps` and shell
 * history; an environment variable is inherited by every child), only from the terminal with
 * nothing echoed, or from stdin when there is no terminal.
 *
 * TTY path: raw mode, one code point at a time. Enter finishes. Ctrl-C aborts at any time and
 * Ctrl-D aborts on an empty line (both give null). Backspace (DEL or ^H) removes one code point,
 * not one UTF-16 unit. An escape sequence (arrow keys, Delete, function keys) is swallowed whole,
 * and any other control character is ignored. NOTHING is echoed, not even a mask: a mask would leak
 * the length. Raw mode is always switched off again, in a finally, and a newline is written.
 *
 * Non-TTY path: the line prompter `init` already uses (src/cli/prompt.js), one line per secret, in
 * order. Several secrets in one run must share ONE reader, because a line-buffered stream would
 * otherwise hand the later lines to the first reader.
 */

function readTty({ input, output, prompt }) {
  return new Promise((resolve) => {
    const chars = [];
    let state = 'plain'; // 'esc' after ESC, 'csi' inside ESC [ ..., 'ss3' after ESC O
    if (prompt) output.write(prompt);
    input.setRawMode(true);
    input.resume();
    if (typeof input.setEncoding === 'function') input.setEncoding('utf8');

    function finish(value) {
      input.removeListener('data', onData);
      try {
        input.setRawMode(false);
      } finally {
        input.pause();
        output.write('\n');
        resolve(value);
      }
    }

    function onData(chunk) {
      for (const ch of String(chunk)) {
        if (state === 'esc') {
          state = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'plain';
          continue;
        }
        if (state === 'csi') {
          const c = ch.codePointAt(0);
          if (c >= 0x40 && c <= 0x7e) state = 'plain';
          continue;
        }
        if (state === 'ss3') {
          state = 'plain';
          continue;
        }
        if (ch === '\u001b') {
          state = 'esc';
          continue;
        }
        if (ch === '\r' || ch === '\n') return finish(chars.join(''));
        if (ch === '\u0003') return finish(null);
        if (ch === '\u0004') {
          if (chars.length === 0) return finish(null);
          continue;
        }
        if (ch === '\u007f' || ch === '\b') {
          chars.pop();
          continue;
        }
        if (ch.codePointAt(0) < 0x20) continue;
        chars.push(ch);
      }
      return undefined;
    }

    input.on('data', onData);
  });
}

/**
 * @param {{ input?: NodeJS.ReadStream, output?: NodeJS.WriteStream }} [opts]
 * @returns {{ read: (prompt: string) => Promise<string|null>, close: () => void, isTTY: boolean }}
 */
function createSecretReader({ input = process.stdin, output = process.stdout } = {}) {
  const tty = Boolean(input.isTTY && typeof input.setRawMode === 'function');
  let prompter = null;
  return {
    isTTY: tty,
    async read(prompt) {
      if (tty) return readTty({ input, output, prompt });
      if (prompter === null) prompter = createPrompter({ input, output });
      return prompter.ask('');
    },
    close() {
      if (prompter !== null) prompter.close();
    },
  };
}

/**
 * One secret, one reader.
 *
 * @param {{ input?: NodeJS.ReadStream, output?: NodeJS.WriteStream, prompt?: string }} [opts]
 * @returns {Promise<string|null>} null on cancel or end of input
 */
async function readSecret({ input = process.stdin, output = process.stdout, prompt = '' } = {}) {
  const reader = createSecretReader({ input, output });
  try {
    return await reader.read(prompt);
  } finally {
    reader.close();
  }
}

module.exports = { readSecret, createSecretReader };
