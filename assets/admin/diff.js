'use strict';

/*
 * V1b SD-4: DF, a pure line-diff namespace (shared design pattern: vocab.js's VB precedent --
 * pure exports above a node module.exports guard, then the browser singleton). Used by the save
 * review slip (slip.js) to render "Also happens to the file"'s +/- diff. Stub only: every export
 * is present with the right shape but a placeholder body; test/admin-diff.test.js drives the
 * real implementation in the C3 commit.
 */
(function () {
  var MAX_CELLS = 4000000;

  function splitLines(t) {
    if (t === null || t === undefined || t === '') return [];
    var lines = String(t).split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /**
   * A verbatim port of docs/agent-runs/panel-v2-mockups/shell.src.html's LCS diffLines(), plus
   * the MAX_CELLS cap and splitLines() so callers can pass raw file text (or null, for "this
   * file doesn't exist yet") straight through, matching how the slip calls it: "DF over
   * dry.before and dry.after" (Engineering Brief, SL.buildSlip). On a tie the L[i+1][j] >= L[i][j+1]
   * comparison favours deletion (the shell.src.html:1001-1015 rule) -- never changed here.
   */
  function diffLines(a, b) {
    var av = splitLines(a);
    var bv = splitLines(b);
    var n = av.length;
    var m = bv.length;
    if (n * m > MAX_CELLS) return { tooLarge: true, ops: [] };

    var L = [];
    var i;
    var j;
    for (i = 0; i <= n; i++) L.push(new Uint16Array(m + 1));
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        L[i][j] = av[i] === bv[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }

    var ops = [];
    i = 0;
    j = 0;
    while (i < n && j < m) {
      if (av[i] === bv[j]) {
        ops.push({ t: '=', o: i + 1, n: j + 1, s: av[i] });
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) {
        ops.push({ t: '-', o: i + 1, s: av[i] });
        i++;
      } else {
        ops.push({ t: '+', n: j + 1, s: bv[j] });
        j++;
      }
    }
    while (i < n) {
      ops.push({ t: '-', o: i + 1, s: av[i] });
      i++;
    }
    while (j < m) {
      ops.push({ t: '+', n: j + 1, s: bv[j] });
      j++;
    }
    return { tooLarge: false, ops: ops };
  }

  function counts(ops) {
    var added = 0;
    var removed = 0;
    ops.forEach(function (op) {
      if (op.t === '+') added++;
      if (op.t === '-') removed++;
    });
    return { added: added, removed: removed };
  }

  /**
   * Change rows (t: '-'/'+', and '=' rows within `context` lines of a change) plus {gap:N} rows
   * collapsing runs of unchanged lines longer than that. A run exactly `context` lines long never
   * collapses (both its ends are within context of the adjacent change).
   */
  function hunks(ops, context) {
    var out = [];
    var i = 0;
    while (i < ops.length) {
      if (ops[i].t !== '=') {
        out.push(ops[i]);
        i++;
        continue;
      }
      // Measure the run of consecutive '=' ops starting at i.
      var start = i;
      var end = i;
      while (end < ops.length && ops[end].t === '=') end++;
      var runLen = end - start;

      var keepBefore = start === 0 ? 0 : Math.min(context, runLen);
      var keepAfter = end === ops.length ? 0 : Math.min(context, runLen);
      // Avoid double-counting when the whole run is short enough that "before" and "after"
      // context windows overlap or cover it entirely.
      if (keepBefore + keepAfter >= runLen) {
        for (var k = start; k < end; k++) out.push(ops[k]);
      } else {
        for (var b = start; b < start + keepBefore; b++) out.push(ops[b]);
        var gapLen = runLen - keepBefore - keepAfter;
        out.push({ gap: gapLen });
        for (var a = end - keepAfter; a < end; a++) out.push(ops[a]);
      }
      i = end;
    }
    return out;
  }

  var DF = { MAX_CELLS: MAX_CELLS, splitLines: splitLines, diffLines: diffLines, counts: counts, hunks: hunks };

  if (typeof module === 'object' && module.exports) {
    module.exports = { DF: DF };
    return;
  }

  window.ScriptoriumAdmin = window.ScriptoriumAdmin || {};
  window.ScriptoriumAdmin.DF = DF;
})();
