'use strict';

const path = require('path');
const { extractWikiLinks } = require('../vault/links');

/*
 * The data status pulls out of the vault. Deliberately reads the vault
 * directly and is NOT bound by publish exclusions (Requirements section
 * 3.4: "status reads the vault directly ... it must not silently report
 * 'no sessions' the way the site did"), so it uses the census index, not
 * the published set.
 */

function lastSession(index) {
  const sessions = index.files.filter((f) => f.ok && f.data.type === 'session');
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => (Number(b.data.session_number) || 0) - (Number(a.data.session_number) || 0));
  const latest = sessions[0];
  return {
    relPath: latest.relPath,
    title: path.basename(latest.relPath, '.md'),
    sessionNumber: latest.data.session_number ?? null,
    playDate: latest.data.play_date ?? null,
  };
}

/** Best-effort: a session-plan with no corresponding Recap yet, i.e. the next unplayed session. */
function nextSession(index) {
  const plans = index.files.filter((f) => f.ok && f.data.type === 'session-plan');
  const playedTitles = new Set(
    index.files
      .filter((f) => f.ok && f.data.type === 'session')
      .map((f) => path.basename(f.relPath, '.md')),
  );
  for (const plan of plans.sort((a, b) => (a.relPath < b.relPath ? -1 : 1))) {
    const sessionRef = plan.data.session;
    const target = sessionRef ? String(sessionRef).replace(/\[\[|\]\]/g, '').trim() : null;
    if (target && playedTitles.has(target)) continue; // already played
    const dateField = plan.data.next_session_date || plan.data.scheduled_date || plan.data.date || null;
    return { relPath: plan.relPath, title: path.basename(plan.relPath, '.md'), date: dateField };
  }
  return null;
}

function countsFor(index) {
  let files = 0;
  let wikiLinks = 0;
  let unresolvedLinks = 0;
  let portraitsWired = 0;
  const entitiesByType = {};

  for (const f of index.files) {
    files++;
    if (!f.ok) continue;
    if (f.data.type) entitiesByType[f.data.type] = (entitiesByType[f.data.type] || 0) + 1;
    if (f.data.portrait) portraitsWired++;
    // ignoreCode (#77): keep this count aligned with link/unresolved's own
    // definition of "a link" — a [[wikilink]] documented inside a code span
    // is not one, matching src/checks/link.js's runUnresolved.
    for (const link of extractWikiLinks(f.raw, { ignoreCode: true })) {
      wikiLinks++;
      if (!index.resolves(link.target)) unresolvedLinks++;
    }
  }

  return { files, entitiesByType, wikiLinks, unresolvedLinks, portraitsWired };
}

module.exports = { lastSession, nextSession, countsFor };
