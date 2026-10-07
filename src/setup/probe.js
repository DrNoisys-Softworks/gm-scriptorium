'use strict';

const fs = require('fs');
const path = require('path');

/*
 * FR-16 (docs/decisions/0028-installer-and-first-run.md, section 3): path checks never stall the
 * panel. locateVault and assertSafeOutputDir are synchronous, and a synchronous existence check
 * against an unreachable network host can block the whole process for a long time. So browser
 * setup first asks an ASYNCHRONOUS question on libuv's thread pool and gives up after a bound; the
 * shared synchronous validators are called only after a probe has answered ok or missing.
 *
 * At most MAX_IN_FLIGHT calls may be running at once. A call that times out is still running (it
 * holds a thread until the operating system gives up), so it keeps counting until it settles; that
 * is the residual ADR 0028 records ("a hanging probe holding one of libuv's four threads").
 * Worker threads are not used: test/admin-variants.test.js forbids them under src/admin, and they
 * are a packaging risk.
 */

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_IN_FLIGHT = 2;
const MAX_CHILDREN = 500;

let inFlight = 0;

function inFlightCount() {
  return inFlight;
}

function classify(err) {
  const code = err && err.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error';
}

/**
 * Runs one filesystem call under the bound and the concurrency cap.
 *
 * @param {() => Promise<any>} op
 * @param {number} timeoutMs
 * @returns {Promise<{ state: 'ok'|'missing'|'timeout'|'error'|'busy', value?: any }>}
 */
function bounded(op, timeoutMs) {
  if (inFlight >= MAX_IN_FLIGHT) return Promise.resolve({ state: 'busy' });
  inFlight++;
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Unref'd: this timer must never be the thing that keeps the panel (or a test) alive.
    timer = setTimeout(() => finish({ state: 'timeout' }), timeoutMs);
    timer.unref();
    let pending;
    try {
      pending = Promise.resolve(op());
    } catch (err) {
      inFlight--;
      finish({ state: classify(err) });
      return;
    }
    pending.then(
      (value) => {
        inFlight--;
        finish({ state: 'ok', value });
      },
      (err) => {
        inFlight--;
        finish({ state: classify(err) });
      },
    );
  });
}

/**
 * @param {string} p
 * @param {{ timeoutMs?: number, fsp?: { stat: Function } }} [opts]
 * @returns {Promise<'ok'|'missing'|'timeout'|'error'|'busy'>}
 */
async function probePath(p, { timeoutMs = DEFAULT_TIMEOUT_MS, fsp = fs.promises } = {}) {
  return (await bounded(() => fsp.stat(p), timeoutMs)).state;
}

/** String-based: \\host\share or //host/share (a share name is required). Never touches the filesystem. */
function isUncPath(s) {
  if (typeof s !== 'string') return false;
  return /^(?:\\\\|\/\/)[^\\/]+[\\/]+[^\\/]+/.test(s);
}

/**
 * One level down only: the first folder (in sorted order, from at most the first MAX_CHILDREN
 * entries) that holds _meta/vault-config.md. Every call is probed and bounded.
 *
 * @param {string} dir
 * @param {{ timeoutMs?: number, fsp?: { stat: Function, readdir: Function } }} [opts]
 * @returns {Promise<string|null>}
 */
async function findVaultChild(dir, { timeoutMs = DEFAULT_TIMEOUT_MS, fsp = fs.promises } = {}) {
  const listing = await bounded(() => fsp.readdir(dir, { withFileTypes: true }), timeoutMs);
  if (listing.state !== 'ok' || !Array.isArray(listing.value)) return null;
  const names = listing.value
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_CHILDREN);
  for (const name of names) {
    const child = path.join(dir, name);
    if ((await probePath(path.join(child, '_meta', 'vault-config.md'), { timeoutMs, fsp })) === 'ok') return child;
  }
  return null;
}

module.exports = { probePath, isUncPath, findVaultChild, inFlightCount, DEFAULT_TIMEOUT_MS, MAX_IN_FLIGHT };
