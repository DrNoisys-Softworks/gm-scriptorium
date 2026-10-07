'use strict';

const readline = require('readline');

/*
 * ADR 0021: the line prompter `init` uses instead of rl.question. Two
 * readline behaviours make rl.question unsafe here:
 *
 *  - rl.question drops lines when stdin is piped. Readline emits every
 *    line of a chunk at once, and only the first one reaches the pending
 *    question; the rest are lost. A queue of 'line' events, drained by
 *    ask() in FIFO order, never drops one.
 *  - In terminal mode, readline with no 'SIGINT' listener pauses on Ctrl-C
 *    instead of exiting.
 *
 * ask() never rejects: it resolves null on EOF ('close') or an interrupt,
 * so a caller can treat both uniformly as "the user is done answering".
 */

/**
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream, signals?: NodeJS.EventEmitter }} opts
 * @returns {{ ask(question: string): Promise<string|null>, say(line: string): void, close(): void, rl: readline.Interface }}
 */
function createPrompter({ input, output, signals = process }) {
  const terminal = Boolean(input.isTTY && output.isTTY);
  const rl = readline.createInterface({ input, output, terminal });

  const lineQueue = [];
  const waiters = []; // pending resolve()s for ask() calls awaiting the next line
  let closed = false;

  function deliver(value) {
    if (waiters.length > 0) {
      waiters.shift()(value);
    } else {
      lineQueue.push(value);
    }
  }

  rl.on('line', (line) => deliver(line));
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()(null);
  });

  function onSigint() {
    rl.close();
  }

  if (terminal) {
    rl.on('SIGINT', onSigint);
  } else {
    signals.once('SIGINT', onSigint);
  }

  function removeSignalListener() {
    if (!terminal) signals.removeListener('SIGINT', onSigint);
  }

  /**
   * @returns {Promise<string|null>} never rejects. A line already queued
   * before EOF/interrupt is still delivered; only an empty queue on a
   * closed interface resolves null (queue order beats close order, since
   * a piped source can finish reading well before its lines are all asked
   * for).
   */
  function ask(question) {
    return new Promise((resolve) => {
      const settle = (value) => {
        if (!terminal && value !== null) output.write('\n');
        resolve(value);
      };
      if (closed) {
        // rl.prompt() on a closed interface throws ERR_USE_AFTER_CLOSE on newer Node (seen on 25.5,
        // not on 22.23), which would reject this promise. Write the question the way a
        // non-terminal rl.prompt() does and fall through: a line queued before the close is still
        // delivered, else null.
        output.write(question);
      } else {
        rl.setPrompt(question);
        rl.prompt();
      }
      if (lineQueue.length > 0) {
        settle(lineQueue.shift());
        return;
      }
      if (closed) {
        resolve(null);
        return;
      }
      waiters.push(settle);
    });
  }

  function say(line) {
    output.write(`${line}\n`);
  }

  /** Idempotent: removes the signals listener and calls rl.close(). */
  function close() {
    if (closed) return;
    closed = true;
    removeSignalListener();
    rl.close();
  }

  return { ask, say, close, rl };
}

module.exports = { createPrompter };
