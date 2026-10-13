'use strict';

/*
 * Fixed test ports (issue #91). A test that has to bind a fixed port takes it from testPort(<default>)
 * so one variable, SCRIPTORIUM_TEST_PORT_BASE, moves every one of them by the same amount and two
 * copies of the suite can run at the same time. Unset, every port is exactly its literal.
 *
 *   testPort(p) = p - 7000 + base        base defaults to 7000
 *
 * The default must be an integer from 7000 to 9999 (span 3000). The base must be a whole number from
 * 1024 to 29768, so every shifted port stays at or below 32767, under the Linux (32768 and up) and
 * Windows (49152 and up) ephemeral ranges. Anything else throws one line naming the variable.
 * Tests that bind port 0, or that never reach a socket, do not use this.
 * Not a *.test.js file, so `node --test` does not run it.
 */

const ENV_NAME = 'SCRIPTORIUM_TEST_PORT_BASE';
const PORT_ANCHOR = 7000;
const PORT_SPAN = 3000;
const BASE_MIN = 1024;
const BASE_MAX = 29768; // 32767 - (PORT_SPAN - 1)

function portBase(env = process.env) {
  const raw = env[ENV_NAME];
  if (raw === undefined || raw === '') return PORT_ANCHOR;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < BASE_MIN || n > BASE_MAX) {
    throw new Error(`${ENV_NAME} must be a whole number from ${BASE_MIN} to ${BASE_MAX}; got "${raw}"`);
  }
  return n;
}

function testPort(defaultPort, env = process.env) {
  if (!Number.isInteger(defaultPort) || defaultPort < PORT_ANCHOR || defaultPort >= PORT_ANCHOR + PORT_SPAN) {
    throw new Error(`testPort needs an integer from ${PORT_ANCHOR} to ${PORT_ANCHOR + PORT_SPAN - 1}; got ${String(defaultPort)}`);
  }
  return defaultPort - PORT_ANCHOR + portBase(env);
}

module.exports = { ENV_NAME, PORT_ANCHOR, PORT_SPAN, portBase, testPort };
