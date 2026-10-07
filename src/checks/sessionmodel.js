'use strict';

/*
 * ADR 0036 (docs/agent-runs/r2-session-wrap-architect-2026-09-30.md): replaces the "not supported
 * yet" notice (census/session-wrap-unsupported) with three read-only pre-flight warnings, and
 * supplies the withheld-hub-body memoisation the leak checks read (SD-5).
 *
 * `sessionPairingFor` recomputes the pairing once per check context (memoised on the ctx object
 * itself, via a WeakMap, so `outputgate.js`'s own shared context -- built for every `build`, not
 * just `check` -- never pays for the vault walk unless something actually asks for the pairing).
 */

const { createFinding } = require('../report/finding');
const sessionpairs = require('../vault/sessionpairs');
const { deriveRenderedText } = require('./leak/textmodel');
const { DEFAULT_VOCAB } = require('../build/labels');

const pairingCache = new WeakMap();

/**
 * @param {object} ctx a check context (src/checks/context.js's buildCheckContext)
 * @returns {object} sessionpairs.computeSessionPairing's result
 */
function sessionPairingFor(ctx) {
  let pairing = pairingCache.get(ctx);
  if (!pairing) {
    pairing = sessionpairs.computeSessionPairing({ vaultPath: ctx.vaultPath, publishSet: ctx.publishSet });
    pairingCache.set(ctx, pairing);
  }
  return pairing;
}

/**
 * @param {object} ctx
 * @param {object} page a published page (ctx.publishSet.publishedPages member)
 * @returns {boolean}
 */
function hubBodyWithheld(ctx, page) {
  return module.exports.sessionPairingFor(ctx).withheldHubs.has(page.relPath);
}

function findPage(ctx, relPath) {
  return (
    ctx.publishSet.publishedPages.find((p) => p.relPath === relPath) ||
    ctx.publishSet.unpublishedPages.find((p) => p.relPath === relPath) ||
    null
  );
}

/**
 * census/session-wrap-hub-unpublished (case e): a published Wrap-Up paired, in the WIDE pairing
 * (the corpus plus the notes it excludes), with a hub that is not itself published -- so the site
 * has no session page for it at all. `widePairs` is what makes this visible whether the hub was
 * merely `publish: false` (still scanned) or sits in an excludeDirs'd folder the scan never
 * reaches (Lead's gap 1, option A).
 */
function runWrapUpHubUnpublished(ctx) {
  const pairing = module.exports.sessionPairingFor(ctx);
  const findings = [];
  for (const pair of pairing.widePairs) {
    if (pair.hub.published) continue;
    if (!pairing.publishedWrapUps.includes(pair.wrapUp.relPath)) continue;
    findings.push(
      createFinding({
        id: 'census/session-wrap-hub-unpublished',
        severity: 'warn',
        category: 'census',
        campaign: ctx.campaign,
        path: pair.wrapUp.relPath,
        message: `${pair.wrapUp.relPath}: this Wrap-Up is linked to ${pair.hub.relPath}, which isn't published, so the site has no session page for it: no session badges, no Latest Session recap, and nothing on the timeline or in Connections. Publish the session note, or keep the recap as a session note.`,
        data: { wrapUp: pair.wrapUp.relPath, hub: pair.hub.relPath },
      }),
    );
  }
  return findings;
}

/**
 * census/session-wrap-link-unpaired: a published Wrap-Up an explicit link touches (pairing.linked)
 * but that never resolved to exactly one hub, in either the standard or the wide pairing --
 * ambiguous links and chapter mismatches (lib/session-hub.js's own `nearest`).
 */
function runWrapUpLinkUnpaired(ctx) {
  const pairing = module.exports.sessionPairingFor(ctx);
  const pairedWrapUps = new Set([...pairing.pairs, ...pairing.widePairs].map((p) => p.wrapUp.relPath));
  const findings = [];
  for (const relPath of pairing.linked) {
    if (pairedWrapUps.has(relPath)) continue;
    findings.push(
      createFinding({
        id: 'census/session-wrap-link-unpaired',
        severity: 'warn',
        category: 'census',
        campaign: ctx.campaign,
        path: relPath,
        message: `${relPath}: this Wrap-Up links to a session, but the link matches more than one note (or a note in another chapter), so it isn't paired with any session. Make the link name exactly one session note.`,
        data: { wrapUp: relPath },
      }),
    );
  }
  return findings;
}

/**
 * census/session-wrap-learned-missing: a published hub paired with a Wrap-Up, where the hub's OWN
 * unwithheld body (deriveRenderedText without bodyWithheld -- what a GM actually wrote, not what
 * the site ships) still carries the learned-items heading, but the Wrap-Up that now supplies the
 * site's learned items does not. The comparison is case-insensitive, whitespace-collapsed.
 */
function runWrapUpLearnedMissing(ctx) {
  const pairing = module.exports.sessionPairingFor(ctx);
  const vocab = (ctx.packToml && ctx.packToml.vocab) || DEFAULT_VOCAB;
  const wanted = vocab.learnedHeading.toLowerCase().replace(/\s+/g, ' ').trim();

  function hasLearnedHeading(page) {
    const rendered = deriveRenderedText(page, ctx.publishSet.publishConfig);
    return rendered.headings.some(
      (h) => h.level === 2 && h.title.toLowerCase().replace(/\s+/g, ' ').trim() === wanted,
    );
  }

  const findings = [];
  for (const pair of pairing.pairs) {
    if (!pair.hub.published) continue;
    const hub = findPage(ctx, pair.hub.relPath);
    const wrapUp = findPage(ctx, pair.wrapUp.relPath);
    if (!hub || !wrapUp) continue;
    if (!hasLearnedHeading(hub)) continue;
    if (hasLearnedHeading(wrapUp)) continue;
    findings.push(
      createFinding({
        id: 'census/session-wrap-learned-missing',
        severity: 'warn',
        category: 'census',
        campaign: ctx.campaign,
        path: hub.relPath,
        message: `${hub.relPath}: this session note has a "${vocab.learnedHeading}" list, but its Wrap-Up ${wrapUp.relPath} doesn't. Once they're paired the session note's body isn't published, so those items won't reach the timeline. Move the list into the Wrap-Up.`,
        data: { hub: hub.relPath, wrapUp: wrapUp.relPath, heading: vocab.learnedHeading },
      }),
    );
  }
  return findings;
}

module.exports = {
  sessionPairingFor,
  hubBodyWithheld,
  runWrapUpHubUnpublished,
  runWrapUpLinkUnpaired,
  runWrapUpLearnedMissing,
};
