'use strict';

/*
 * The `[update]` table in config.toml (docs/decisions/0028-installer-and-first-run.md, addendum
 * "The update notice"). Two keys: `check` (true or false, absent means on) and `channel` ("stable"
 * or "beta", absent means the running build decides). Other keys inside the table are ignored and
 * kept. Anything this module cannot read exactly makes the whole table UNREADABLE, which means off:
 * a hand-edit that is almost right must never switch a request on. This file requires nothing, so
 * both the config writer and the update code can use it without a cycle.
 */

const CHANNELS = Object.freeze(['stable', 'beta']);

const UNREADABLE = Object.freeze({ readable: false, check: false, channel: null });

/**
 * @param {unknown} raw the value of `config.update`, or undefined when the table is absent
 * @returns {{ readable: boolean, check: boolean, channel: 'stable'|'beta'|null }} never throws
 */
function parseUpdateTable(raw) {
  if (raw === undefined) return { readable: true, check: true, channel: null };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...UNREADABLE };
  let check = true;
  if (Object.prototype.hasOwnProperty.call(raw, 'check')) {
    if (raw.check !== true && raw.check !== false) return { ...UNREADABLE };
    check = raw.check;
  }
  let channel = null;
  if (Object.prototype.hasOwnProperty.call(raw, 'channel')) {
    if (typeof raw.channel !== 'string' || !CHANNELS.includes(raw.channel)) return { ...UNREADABLE };
    channel = raw.channel;
  }
  return { readable: true, check, channel };
}

module.exports = { CHANNELS, parseUpdateTable };
