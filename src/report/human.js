'use strict';

const { SEVERITY_RANK } = require('./finding');

/*
 * The clean-run message (Engineering Brief section 7.0, "Amendment B" in
 * the requirements: "check must never print a clean bill of health that
 * reads as safe to share with players"). This exact string is a single
 * constant so it cannot be softened casually (brief section 14: "Do not
 * soften the clean-run message"). It never says OK, clean, safe, no
 * issues, or shows a tick.
 */
const CLEAN_RUN_MESSAGE = (checkedList, graphOn) =>
  [
    `Ran: ${checkedList.join(', ')}.`,
    graphOn ? 'Graph hygiene checks (--graph) were included.' : 'Graph hygiene checks were not run (pass --graph to include them).',
    'These are deterministic proxies for a leak, not a judgement of one.',
    'They cannot catch forward-looking prep prose that names nobody hidden, or GM-facing framing under a heading nobody listed.',
    'A clean result here is not clearance to share this site with players.',
  ].join(' ');

function severityLabel(sev) {
  return sev.toUpperCase();
}

function renderHuman(envelope, { checkedIds = [], graphOn = false } = {}) {
  const lines = [];
  lines.push(`scriptorium check: ${envelope.campaign}`);
  if (envelope.vaultPath) lines.push(`vault: ${envelope.vaultPath}`);
  lines.push('');

  const sorted = [...envelope.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  for (const f of sorted) {
    const loc = f.path ? `${f.path}${f.line ? ':' + f.line : ''}` : null;
    const head = [severityLabel(f.severity), f.id, loc].filter(Boolean).join(' ');
    lines.push(`${head}  ${f.message}`);
    if (f.detail) lines.push(`    ${f.detail}`);
  }

  lines.push('');
  lines.push(
    `${envelope.counts.error} error(s), ${envelope.counts.warn} warning(s), ${envelope.counts.info} info.`,
  );
  lines.push('');
  lines.push(CLEAN_RUN_MESSAGE(checkedIds, graphOn));

  return lines.join('\n');
}

module.exports = { renderHuman, CLEAN_RUN_MESSAGE };
