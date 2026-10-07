'use strict';

const { createFinding } = require('../../report/finding');

/**
 * L1: publish.mode is player and _meta/publish-manifest.md is absent. With
 * no manifest, build.js's image filter (gated on `manifest && mode ===
 * 'player'`) is dead and every file under attachmentsDir is copied
 * regardless of any exclude list. An existence test only: it does not by
 * itself say anything about prose, and a manifest existing does not mean
 * every leak is handled.
 */
function runNoManifest(ctx) {
  if (ctx.publishSet.publishConfig.mode !== 'player') return [];
  if (ctx.publishSet.manifest !== null) return [];
  return [
    createFinding({
      id: 'leak/l1-no-manifest',
      severity: 'error',
      category: 'leak',
      campaign: ctx.campaign,
      path: '_meta/publish-manifest.md',
      message:
        'publish.mode is "player" but _meta/publish-manifest.md is missing. In player mode a page is published ' +
        'only if it is ticked in that file, and the file also decides which images are copied, so without it every ' +
        'file in the attachments folder would be copied to the site. To fix it, create _meta/publish-manifest.md with a ' +
        '"## Publishing" heading and one line for each page players may see, such as "- [x] Locations/Some Place.md". ' +
        'See examples/the-long-lease/_meta/publish-manifest.md for a complete one.',
    }),
  ];
}

module.exports = { runNoManifest };
