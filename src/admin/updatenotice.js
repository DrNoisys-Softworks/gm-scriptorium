'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensurePrivateDir } = require('../remote/privatefile');
const { parseUpdateTable, CHANNELS } = require('../config/updatesettings');
const notice = require('../update/notice');
const { compareVersions } = require('../update/semver');

/*
 * The panel side of the update notice (docs/decisions/0028-installer-and-first-run.md, addendum
 * "The update notice"). One controller per panel process. It owns the state file, the daily rule,
 * one hourly timer and the abort for a check in flight; the check itself (src/update/notice.js) is
 * injected, so tests never reach a network.
 *
 * Rules this file keeps:
 *  - It does no I/O when created. `start()` reads the state file and may run one check; the caller
 *    schedules `start()` after the listeners are up and never awaits it.
 *  - A check runs only in a packaged process that did not start in setup mode, with the `[update]`
 *    setting on, and only when the daily rule says it is due. Everything else only restores.
 *  - A check never writes to the console. Every check promise ends in a catch that swallows, so a
 *    failure is only the quiet `failed` state (an unhandled rejection would end the panel).
 *  - Only a success writes `lastSuccessMs`. A failure is retried at the next start, or a day after
 *    the last attempt in a process that stays up.
 *  - A superseded or stopped check writes nothing (a generation counter).
 *
 * The state file `<panelDir>/update-check.json` is per machine, like welcome.json, and written the
 * same way: a private temp file (0600, in a 0700 folder) and a rename. Reads never throw.
 */

const FILE = 'update-check.json';
const MAX_BYTES = 4096;
const TICK_MS = 3600000;

const EMPTY_STATE = Object.freeze({ lastSuccessMs: null, channel: null, latest: null, prerelease: false, dismissed: null });

function validTime(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function validTag(v) {
  return typeof v === 'string' && notice.isSafeTag(v);
}

/** @param {string} panelDir @returns {object} the stored fields, each empty when missing or invalid; never throws */
function readState(panelDir) {
  const file = path.join(panelDir, FILE);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return { ...EMPTY_STATE };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...EMPTY_STATE };
    return {
      lastSuccessMs: validTime(parsed.lastSuccessMs) ? parsed.lastSuccessMs : null,
      channel: CHANNELS.includes(parsed.channel) ? parsed.channel : null,
      latest: validTag(parsed.latest) ? parsed.latest : null,
      prerelease: parsed.prerelease === true,
      dismissed: validTag(parsed.dismissed) ? parsed.dismissed : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** @throws on an I/O failure */
function writeState(panelDir, state) {
  ensurePrivateDir(panelDir);
  const file = path.join(panelDir, FILE);
  const tmp = path.join(panelDir, `.${FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const shape = {
    lastSuccessMs: state.lastSuccessMs,
    channel: state.channel,
    latest: state.latest,
    prerelease: state.prerelease === true,
    dismissed: state.dismissed,
  };
  const data = Buffer.from(`${JSON.stringify(shape, null, 2)}\n`, 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, data, 0, data.length, null);
    fs.closeSync(fd);
    fd = undefined;
    // Deliberately no fsync and no Windows rename retry (as in welcome.js): a result lost to a crash
    // or a briefly locked file only means the next start checks again.
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: the original error below is what gets reported.
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // swallowed deliberately: the caller's own error already explains what went wrong.
    }
    throw err;
  }
}

function display(version) {
  return typeof version === 'string' ? version.replace(/^v/, '') : null;
}

/**
 * @param {{ panelDir: string, config?: object, currentVersion: string, setupMode?: boolean, isPkg?: boolean,
 *   check?: Function, now?: () => number }} opts
 */
function createUpdateNotice({ panelDir, config = {}, currentVersion, setupMode = false, isPkg = typeof process.pkg !== 'undefined', check, now = Date.now }) {
  const runCheck = check || ((args) => notice.checkForUpdate(args));
  const parsed = parseUpdateTable(config && config.update);
  let setting = !parsed.readable ? 'unreadable' : parsed.check ? 'on' : 'off';
  let savedChannel = parsed.channel;

  let stored = { ...EMPTY_STATE };
  let state = setting === 'on' ? 'idle' : 'off';
  let latestTag = null;
  let latestPrerelease = false;
  let lastAttemptMs = null;
  let generation = 0;
  let stopped = false;
  let abort = null;
  let timer = null;

  const channelNow = () => notice.effectiveChannel(savedChannel, currentVersion);
  const canCheck = () => isPkg === true && setupMode !== true && setting === 'on' && !stopped;

  function cancelInFlight() {
    generation++;
    if (abort !== null) {
      abort.abort();
      abort = null;
    }
  }

  /** Puts `state` and the shown version back from what is stored, with no request. */
  function restore() {
    latestTag = null;
    latestPrerelease = false;
    if (setting === 'unreadable') {
      state = 'off';
      return;
    }
    if (setting === 'off') {
      state = 'off';
      return;
    }
    const fresh = !notice.isDue(stored.lastSuccessMs, now()) && stored.channel === channelNow();
    if (!fresh) {
      state = 'idle';
      return;
    }
    if (stored.latest !== null && compareVersions(currentVersion, stored.latest) === -1) {
      latestTag = stored.latest;
      latestPrerelease = stored.prerelease === true;
      state = 'available';
    } else {
      state = 'current';
    }
  }

  function saveStored() {
    try {
      writeState(panelDir, stored);
    } catch {
      // swallowed deliberately: the result still shows for this run, and the next start checks again.
    }
  }

  /** One check. Always resolves; never writes to the console. */
  function startCheck() {
    cancelInFlight();
    const myGen = generation;
    const controller = new AbortController();
    abort = controller;
    const channel = channelNow();
    lastAttemptMs = now();
    state = 'checking';
    latestTag = null;
    latestPrerelease = false;
    let promise;
    try {
      promise = Promise.resolve(runCheck({ channel, currentVersion, signal: controller.signal }));
    } catch (err) {
      promise = Promise.reject(err);
    }
    return promise
      .then(
        (result) => {
          if (stopped || myGen !== generation) return;
          abort = null;
          const at = now();
          if (result && result.state === 'available' && notice.isSafeTag(result.tag)) {
            stored = { ...stored, lastSuccessMs: at, channel, latest: result.tag, prerelease: result.prerelease === true };
            latestTag = result.tag;
            latestPrerelease = result.prerelease === true;
            state = 'available';
          } else {
            stored = { ...stored, lastSuccessMs: at, channel, latest: null, prerelease: false };
            state = 'current';
          }
          saveStored();
        },
        () => {
          if (stopped || myGen !== generation) return;
          abort = null;
          state = 'failed';
        },
      )
      .catch(() => {});
  }

  function arm() {
    if (timer !== null || !canCheck()) return;
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
  }

  function disarm() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** Runs a check when one is allowed and due. Resolves when it has settled (or at once when none ran). */
  async function tick() {
    if (!canCheck() || state === 'checking') return;
    const at = now();
    if (lastAttemptMs !== null && at - lastAttemptMs <= notice.DAY_MS) return;
    const due = notice.isDue(stored.lastSuccessMs, at) || stored.channel !== channelNow();
    if (!due) return;
    await startCheck();
  }

  /** Reads the state file, shows what it holds, runs a due check and arms the hourly timer. */
  async function start() {
    if (stopped) return;
    stored = readState(panelDir);
    if (setting === 'unreadable') stored = { ...EMPTY_STATE };
    restore();
    if (!canCheck()) return;
    arm();
    if (state === 'idle') await startCheck();
  }

  function stop() {
    stopped = true;
    cancelInFlight();
    disarm();
  }

  /**
   * @param {'check'|'channel'} key
   * @param {boolean|string} value
   * @returns {Promise<void>} for a channel change that starts a check, the check's end; else already settled
   */
  function applySetting(key, value) {
    if (stopped || setting === 'unreadable') return Promise.resolve();
    if (key === 'check') {
      if (value === false) {
        cancelInFlight();
        disarm();
        setting = 'off';
        state = 'off';
        latestTag = null;
        latestPrerelease = false;
      } else if (value === true) {
        setting = 'on';
        lastAttemptMs = now();
        restore();
        arm();
      }
      return Promise.resolve();
    }
    if (key === 'channel' && CHANNELS.includes(value)) {
      savedChannel = value;
      cancelInFlight();
      latestTag = null;
      latestPrerelease = false;
      if (setting === 'on' && canCheck()) return startCheck();
      state = 'off';
    }
    return Promise.resolve();
  }

  /** @throws {Error} unless `tag` is the tag being shown, or on a write failure */
  function dismiss(tag) {
    if (stopped) throw new Error('the update notice has stopped');
    if (typeof tag !== 'string' || latestTag === null || tag !== latestTag) throw new Error('that is not the version being shown');
    const next = { ...stored, dismissed: tag };
    writeState(panelDir, next);
    stored = next;
  }

  function snapshot() {
    const prereleaseBuild = notice.defaultChannel(currentVersion) === 'beta';
    const channel = setting === 'unreadable' ? null : channelNow();
    return {
      setting,
      channel,
      channelSaved: setting !== 'unreadable' && savedChannel !== null,
      defaultChannel: notice.defaultChannel(currentVersion),
      prereleaseBuild,
      state,
      current: display(currentVersion),
      latest: latestTag === null ? null : display(latestTag),
      latestTag,
      beta: channel === 'beta' && latestPrerelease === true && latestTag !== null,
      notesUrl: latestTag === null ? null : notice.notesUrl(latestTag),
      dismissed: latestTag !== null && stored.dismissed === latestTag,
      lastSuccessMs: setting === 'unreadable' ? null : stored.lastSuccessMs,
    };
  }

  return { start, stop, tick, snapshot, dismiss, applySetting };
}

module.exports = { createUpdateNotice, readState, writeState, FILE, MAX_BYTES, TICK_MS };
