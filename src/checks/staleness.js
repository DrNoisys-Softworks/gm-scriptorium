'use strict';

const { createFinding } = require('../report/finding');
const read = require('../vault/read');

/**
 * Parses an `asOfSession` value. Only a whole non-negative integer counts, given as a number or
 * as a string of digits (quoted or not in the YAML). Anything else (`prep-s02`, `book`, a
 * wikilink, empty, missing, negative, fractional) returns null: no finding and no guess.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function parseAsOfSession(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * staleness/story-behind-pc (issue 13, case 1): a PC page's paired `<Name>_Story.md` (the pairing
 * publishset.js's pairStoryFiles already made, same folder and `type: character-story`) carries a
 * lower `asOfSession` than the PC page, so the story has not been brought up to date. Read-only:
 * the story's frontmatter comes through the vault read chokepoint.
 */
function runStoryBehindPc(ctx) {
  const findings = [];
  const pages = [...ctx.publishSet.publishedPages, ...ctx.publishSet.unpublishedPages];
  for (const pc of pages) {
    if (pc.frontmatter.type !== 'pc') continue;
    if (!pc.storySourcePath || !pc.storyRelPath) continue;
    const pcSession = parseAsOfSession(pc.frontmatter.asOfSession);
    if (pcSession === null) continue;
    const story = read.readFrontmatter(pc.storySourcePath);
    if (!story.ok) continue;
    const storySession = parseAsOfSession(story.data.asOfSession);
    if (storySession === null) continue;
    if (storySession < pcSession) {
      findings.push(
        createFinding({
          id: 'staleness/story-behind-pc',
          severity: 'warn',
          category: 'census',
          campaign: ctx.campaign,
          path: pc.storyRelPath,
          message: `${pc.storyRelPath}: story is as of session ${storySession} but ${pc.relPath} is as of session ${pcSession}, so the story is behind its stats page`,
          data: {
            pc: pc.relPath,
            story: pc.storyRelPath,
            pcAsOfSession: pcSession,
            storyAsOfSession: storySession,
          },
        }),
      );
    }
  }
  return findings;
}

module.exports = { runStoryBehindPc, parseAsOfSession };
