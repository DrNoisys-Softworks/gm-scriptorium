/* Scriptorium site runtime (ES5, one IIFE, no modules).
 *
 * Engineering Brief: "Story timeline + Connections lane" (docs/agent-runs/
 * timeline-connections-engineering-brief-2026-09-24.md), "assets/site/scriptorium.js".
 * ADR 0020 ("Labels and vocabulary", docs/agent-runs/agnostic-p4-engineering-brief-2026-09-25.md):
 * the label-bearing string builders below are exported pure functions (Structural decision 9), so
 * their defaults can be pinned by literal tests under node (test/site-runtime-vocab.test.js). They,
 * and everything they depend on (TL_GLYPH, the client defaults, PATH_DATA_RE), sit above
 * `module.exports` for that reason -- var initialisers below that line never run under node.
 *
 * Ported from the design exploration (scratchpad tl-work/leaf.js, conn-work/cx.js), keeping only
 * the picked options: bar ruler, mark kind, detail card, phone upright (timeline); lane, cap,
 * brass and reflow (Connections). No locale-aware string comparison or date formatting anywhere
 * in this file (NFR-06) -- every comparison is either untyped equality or the build-time-assigned
 * `rank` field.
 */
(function () {
  'use strict';

  function hasOwn(obj, k) {
    return Object.prototype.hasOwnProperty.call(obj, k);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function extend(a, b) {
    var out = {};
    var k;
    for (k in a) if (hasOwn(a, k)) out[k] = a[k];
    for (k in b) if (hasOwn(b, k)) out[k] = b[k];
    return out;
  }

  // ================================================================================
  // TL -- the story timeline
  // ================================================================================
  var TL = {};

  // -- ADR 0020: client defaults, glyphs and validation (Structural decisions 5/6/9) -------------
  //
  // These reproduce today's exact strings (scriptorium.js:20/21/245-253/260/266-269, before this
  // ADR) -- test/site-runtime-vocab.test.js's R1/R2 pin them against independently-stated literals.

  var TL_GLYPH = {
    fight: '<path d="M4 4l10.5 10.5M16 4L5.5 14.5M11.6 16l4.4-4.4M4 11.6L8.4 16M14.5 14.5l2.3 2.3M5.5 14.5l-2.3 2.3"/>',
    meeting: '<circle cx="7" cy="7.2" r="2.5"/><circle cx="13.4" cy="7.2" r="2.5"/><path d="M2.6 16.2c.6-2.9 2.3-4.4 4.4-4.4s3.8 1.5 4.4 4.4M9 16.2c.6-2.9 2.3-4.4 4.4-4.4s3.8 1.5 4.4 4.4"/>',
    discovery: '<path d="M2 10s3-5.4 8-5.4 8 5.4 8 5.4-3 5.4-8 5.4S2 10 2 10z"/><circle cx="10" cy="10" r="2.3"/>',
    journey: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="1.5"/><path d="M10 3v5.5M10 11.5V17M3 10h5.5M11.5 10H17M5.1 5.1l3.8 3.8M11.1 11.1l3.8 3.8M14.9 5.1l-3.8 3.8M8.9 11.1l-3.8 3.8"/>',
    learned: '<path d="M10 5.6C8 4.3 5.5 4.1 3 4.6v10.2c2.5-.5 5-.3 7 1 2-1.3 4.5-1.5 7-1V4.6c-2.5-.5-5-.3-7 1zM10 5.6v10.2"/>',
    backstory: '<path d="M10 2.2l1.8 5.3 5.6.4-4.4 3.4 1.6 5.5L10 13.6l-4.6 3.2L7 11.3 2.6 7.9l5.6-.4z"/>',
    '': '<circle cx="10" cy="10" r="3.5"/>',
  };

  // Mirrors src/build/labels.js's PATH_DATA_RE exactly (SD-6): the client re-validates a
  // config-supplied glyph before concatenating it as markup, independently of the server.
  var PATH_DATA_RE = /^[Mm][0-9MmZzLlHhVvCcSsQqTtAa.,+\-eE ]{0,1023}$/;

  var TL_DEFAULT_KINDS = [
    { key: 'fight', label: 'fight', glyph: 'fight', before: false },
    { key: 'meeting', label: 'meeting', glyph: 'meeting', before: false },
    { key: 'discovery', label: 'discovery', glyph: 'discovery', before: false },
    { key: 'journey', label: 'journey', glyph: 'journey', before: false },
    { key: 'backstory', label: 'backstory', glyph: 'backstory', before: true },
  ];
  var TL_DEFAULT_WEIGHTS = ['aside', 'scene', 'turning point'];
  var TL_DEFAULT_LABELS = {
    learned_lens: 'What the party learned',
    learned_legend: 'Learned',
    story_lens: 'The story',
    chapter: 'Chapter',
  };

  function tlArticle(word) {
    return /^[aeiou]/i.test(word) ? 'an' : 'a';
  }
  function tlCap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function linksHTML(L) {
    return (L || [])
      .map(function (l) {
        return '<a href="' + esc(l[1]) + '">' + esc(l[0]) + '</a>';
      })
      .join(', ');
  }

  /**
   * @param {{labels?:object,kinds?:object[],weights?:string[]}} [voc] the island's own `voc` delta
   * @returns {{labels:object,kinds:object[],weights:string[],byKey:object}}
   */
  TL.vocab = function (voc) {
    var labels = extend(TL_DEFAULT_LABELS, (voc && voc.labels) || {});
    var kinds = (voc && voc.kinds) || TL_DEFAULT_KINDS;
    var weights = (voc && voc.weights) || TL_DEFAULT_WEIGHTS;
    var byKey = {};
    for (var i = 0; i < kinds.length; i++) byKey[kinds[i].key] = kinds[i];
    return { labels: labels, kinds: kinds, weights: weights, byKey: byKey };
  };

  var TL_DEFAULT_V = TL.vocab();

  function tlKindOf(V, k) {
    return hasOwn(V.byKey, k) ? V.byKey[k] : null;
  }

  /**
   * The inner SVG markup for kind key `k` (the neutral dot for an unknown/empty key). `k ===
   * 'learned'` always uses the built-in learned glyph; otherwise the kind's own glyph is used,
   * re-validated here regardless of what src/build/labels.js already checked server-side (SD-6).
   *
   * @param {string} k
   * @param {object} [V] TL.vocab()'s return shape; defaults to the client defaults
   * @returns {string}
   */
  TL.glyph = function (k, V) {
    V = V || TL_DEFAULT_V;
    if (k === 'learned') return TL_GLYPH.learned;
    var kind = tlKindOf(V, k);
    var g = kind ? kind.glyph : '';
    if (hasOwn(TL_GLYPH, g)) return TL_GLYPH[g];
    if (PATH_DATA_RE.test(g)) return '<path d="' + g + '"/>';
    return TL_GLYPH[''];
  };

  function tlGlyphSvg(k, V) {
    return '<svg class="sc-tl-g" viewBox="0 0 20 20" aria-hidden="true">' + TL.glyph(k, V) + '</svg>';
  }

  /**
   * @param {{k:string,w:number}} p
   * @param {object} [V]
   * @returns {string}
   */
  TL.kindLine = function (p, V) {
    V = V || TL_DEFAULT_V;
    if (p.k === 'learned') return V.labels.learned_lens;
    var kind = tlKindOf(V, p.k);
    if (kind && kind.before) return tlCap(kind.label);
    var weightWord = V.weights[p.w - 1] || V.weights[1];
    if (kind) {
      var kindWord = kind.label;
      return tlCap(tlArticle(kindWord)) + ' ' + kindWord + ', ' + tlArticle(weightWord) + ' ' + weightWord;
    }
    return tlCap(tlArticle(weightWord)) + ' ' + weightWord;
  };

  /**
   * @param {{k:string}} p
   * @param {object} [V]
   * @returns {string}
   */
  TL.marker = function (p, V) {
    V = V || TL_DEFAULT_V;
    if (p.k === 'learned') return '<span class="sc-tl-book">' + tlGlyphSvg('learned', V) + '</span>';
    var kind = tlKindOf(V, p.k);
    if (kind && kind.before) return '<span class="sc-tl-star">' + tlGlyphSvg(p.k, V) + '</span>';
    return '<span class="sc-tl-kind sc-tl-k-' + esc(p.k || 'none') + '">' + tlGlyphSvg(p.k, V) + '</span>';
  };

  /**
   * @param {boolean} hasLearned
   * @param {object} [V]
   * @returns {string}
   */
  TL.legend = function (hasLearned, V) {
    V = V || TL_DEFAULT_V;
    var items = [];
    var i, k;
    for (i = 0; i < V.kinds.length; i++) {
      k = V.kinds[i];
      if (!k.before) {
        items.push(['<span class="sc-tl-kind sc-tl-k-' + esc(k.key) + '">' + tlGlyphSvg(k.key, V) + '</span>', tlCap(k.label)]);
      }
    }
    for (i = 0; i < V.kinds.length; i++) {
      k = V.kinds[i];
      if (k.before) {
        items.push(['<span class="sc-tl-star">' + tlGlyphSvg(k.key, V) + '</span>', tlCap(k.label)]);
      }
    }
    if (hasLearned) items.push(['<span class="sc-tl-book">' + tlGlyphSvg('learned', V) + '</span>', V.labels.learned_legend]);
    return '<ul class="sc-tl-legend" aria-label="Key">' + items.map(function (i2) { return '<li>' + i2[0] + '<span>' + esc(i2[1]) + '</span></li>'; }).join('') + '</ul>';
  };

  /**
   * @param {boolean} lens
   * @param {boolean} hasLearned
   * @param {object} [V]
   * @returns {string}
   */
  TL.lensBar = function (lens, hasLearned, V) {
    V = V || TL_DEFAULT_V;
    return (
      '<div class="sc-tl-top"><div class="sc-tl-lens" role="group" aria-label="Show">' +
      '<button type="button" data-lens="0" aria-pressed="' + !lens + '">' + esc(V.labels.story_lens) + '</button>' +
      (hasLearned ? '<button type="button" data-lens="1" aria-pressed="' + lens + '">' + esc(V.labels.learned_lens) + '</button>' : '') +
      '</div>' + TL.legend(hasLearned, V) + '</div>'
    );
  };

  /**
   * @param {object} p a point
   * @param {object} data the sc-tl-data island
   * @param {object} [V]
   * @returns {string}
   */
  TL.cardBody = function (p, data, V) {
    V = V || TL_DEFAULT_V;
    var ch = data.ch[String(p.s)];
    var meta = '<p class="sc-tl-meta"><span>' + esc(p.when) + '</span>' + (ch ? '<span>' + esc(V.labels.chapter) + ' ' + esc(ch.num) + ', ' + esc(ch.title) + '</span>' : '') + '</p>';
    return (
      meta +
      '<h3 class="sc-tl-dt">' + esc(p.t) + '</h3>' +
      '<p class="sc-tl-kl">' + esc(TL.kindLine(p, V)) + '</p>' +
      '<p class="sc-tl-dx">' + esc(p.x) + '</p>' +
      '<p class="sc-tl-dl"><span>Read on:</span> ' + linksHTML(p.links) + '</p>'
    );
  };

  /**
   * @param {object} data the sc-tl-data island
   * @param {boolean} lens
   * @param {object} [V]
   * @returns {object[]}
   */
  TL.points = function (data, lens, V) {
    V = V || TL_DEFAULT_V;
    var out = [];
    data.points.forEach(function (p) {
      if (!lens) {
        out.push(extend(p, { ghost: false }));
        return;
      }
      var kind = tlKindOf(V, p.k);
      out.push(extend(p, { ghost: !(kind && kind.before) }));
      data.learned.forEach(function (l) {
        if (l.after === p.id) {
          out.push({ id: l.id, seg: p.seg, s: l.s, w: 2, k: 'learned', t: l.t, x: l.x, when: p.when, links: l.links, ghost: false });
        }
      });
    });
    return out;
  };

  TL.UNIT = 80;
  TL.GUNIT = 30;
  TL.PAD = 34;
  TL.BEFORE_W = 132;
  TL.LINE = 186;
  TL.H = 290;

  /**
   * @param {object[]} points as returned by TL.points
   * @param {object[]} segs the sc-tl-data island's segs
   * @returns {{points: object[], segX: object, segW: object, width: number, unit: number, gunit: number, beforeW: number}}
   */
  TL.layout = function (points, segs) {
    var unit = TL.UNIT, gunit = TL.GUNIT, pad = TL.PAD, beforeW = TL.BEFORE_W;
    var x = 0, segX = {}, segW = {};
    var positioned = points.map(function (p) {
      return extend(p, {});
    });
    segs.forEach(function (s) {
      var list = positioned.filter(function (p) {
        return p.seg === s.id;
      });
      var w;
      if (s.before) {
        w = beforeW;
        list.forEach(function (p) {
          p._x = x + w / 2;
        });
      } else {
        var cx = x + pad / 2;
        list.forEach(function (p) {
          var u = p.ghost ? gunit : unit;
          p._x = cx + u / 2;
          cx += u;
        });
        w = cx - x + pad / 2;
      }
      segX[s.id] = x;
      segW[s.id] = w;
      x += w;
    });
    return { points: positioned, segX: segX, segW: segW, width: x + 20, unit: unit, gunit: gunit, beforeW: beforeW };
  };

  // ================================================================================
  // CX -- the Connections lane
  // ================================================================================
  var CX = {};

  var CX_DEFAULT_LABELS = {
    recap: 'Recap',
    same_recap: 'Same recap',
    group_tie: 'Ties',
    group_named: 'Named by',
    group_pc: 'The party',
    group_npc: 'People',
    group_faction: 'Factions',
    group_location: 'Places',
    group_thing: 'Things',
    group_event: 'Events',
    group_other: 'Other',
  };

  /**
   * @param {{labels?:object}} [voc] the island's own `voc` delta
   * @returns {{labels:object}}
   */
  CX.vocab = function (voc) {
    return { labels: extend(CX_DEFAULT_LABELS, (voc && voc.labels) || {}) };
  };

  var CX_DEFAULT_V = CX.vocab();

  /**
   * @param {string} g a group key (tie, named, pc, npc, faction, location, thing, event, other)
   * @param {object} [V]
   * @returns {string}
   */
  CX.groupTitle = function (g, V) {
    V = V || CX_DEFAULT_V;
    return V.labels['group_' + g];
  };

  /**
   * @param {object} data the sc-cx-data island
   * @param {object} [V]
   * @returns {string}
   */
  CX.hubSess = function (data, V) {
    V = V || CX_DEFAULT_V;
    if (!data.sessions.length) return '';
    return ' <span class="sc-cx-sess">' + data.sessions.map(function (s) { return '<a href="' + esc(s.href) + '" title="' + esc(V.labels.recap) + ' ' + esc(s.num) + ', ' + esc(s.title) + '">' + esc(s.num) + '</a>'; }).join(' ') + '</span>';
  };

  /**
   * @param {object} sel the currently-selected item
   * @param {object} data the sc-cx-data island
   * @param {object} [V]
   * @returns {string}
   */
  CX.traySame = function (sel, data, V) {
    V = V || CX_DEFAULT_V;
    if (!sel.shared || !sel.shared.length) return '';
    var lines = sel.shared
      .map(function (n) {
        var s = data.sessions.filter(function (x) { return x.n === n; })[0];
        return s ? esc(V.labels.recap) + ' ' + esc(s.num) + ', ' + esc(s.title) : '';
      })
      .filter(function (s) { return s; })
      .join('<br>');
    if (!lines) return '';
    return '<div class="sc-cx-same"><b>' + esc(V.labels.same_recap) + '</b>' + lines + '</div>';
  };

  /**
   * @param {number} width the lane container's own clientWidth
   * @returns {6|8}
   */
  CX.capFor = function (width) {
    return width < 600 ? 6 : 8;
  };

  /**
   * @param {object[]} items in display order, each carrying `rank`
   * @param {number} cap
   * @param {boolean} showAll
   * @returns {object[]}
   */
  CX.visible = function (items, cap, showAll) {
    if (showAll) return items.slice();
    return items.filter(function (it) {
      return it.rank <= cap;
    });
  };

  /**
   * @param {object[]} visible
   * @returns {object|null}
   */
  CX.restItem = function (visible) {
    var ties = visible.filter(function (it) {
      return it.kind === 'tie';
    });
    if (ties.length) return ties[ties.length - 1];
    return visible.length ? visible[0] : null;
  };

  // FR-C2/AC-12 (the a1 lane): declared ties, then "Named by", on the left; mentions grouped on
  // the right. The DOM boot below builds the lane by calling CX.side() for every group key, so
  // this is the one place that decision lives -- not re-derived per test, and not duplicated
  // between the render code and its own test.
  CX.GROUP_ORDER = ['tie', 'named', 'pc', 'npc', 'faction', 'location', 'thing', 'event', 'other'];
  CX.LEFT_GROUPS = ['tie', 'named'];
  CX.RIGHT_GROUPS = ['pc', 'npc', 'faction', 'location', 'thing', 'event', 'other'];
  CX.side = function (groupKey) {
    return CX.LEFT_GROUPS.indexOf(groupKey) !== -1 ? 'L' : 'R';
  };

  /**
   * The scroller's scrollLeft that centres the hub in view, or null when the lane already fits
   * (nothing to scroll). Pure so it is testable without a real layout engine; the DOM caller just
   * assigns the result directly to scrollLeft (never scrollTo({behavior:'smooth'}) -- an initial
   * layout position is not a user-triggered scroll, so it is never animated, reduced-motion or not).
   *
   * @param {number} hubLeft the hub element's own offsetLeft within the scroller
   * @param {number} hubWidth the hub element's own offsetWidth
   * @param {number} clientWidth the scroller's own clientWidth
   * @param {number} scrollWidth the scroller's own scrollWidth
   * @returns {number | null}
   */
  CX.centerScrollLeft = function (hubLeft, hubWidth, clientWidth, scrollWidth) {
    if (scrollWidth <= clientWidth) return null;
    var target = hubLeft + hubWidth / 2 - clientWidth / 2;
    var max = scrollWidth - clientWidth;
    return Math.max(0, Math.min(max, target));
  };

  /**
   * Distinguishes a genuine user scroll of the lane from this file's own programmatic writes to
   * scrollLeft (the initial centring, and CX.recentreOnFontsReady's own one-time correction) --
   * the DOM's 'scroll' event carries no signal for which one caused it, so the guard compares
   * positions instead of trusting "the next event". markProgrammatic(target, current) must be
   * called immediately before every such write, with the position being written and the position
   * the element holds now. onScroll(observed) is then given the element's scrollLeft as the event
   * is handled, and treats the event as that write's echo only when observed is within 1px of
   * target (the browser may clamp or round the write); any other position is a real scroll, so a
   * user scroll coalesced into the echo's event is never swallowed. The mark is spent by the first
   * event either way. A write that leaves the position unchanged (target within 1px of current)
   * fires no event, so it is not armed at all and cannot swallow a later real scroll. onScroll
   * with no position cannot be classified, so it reports a real scroll. Pure state, no DOM of
   * its own, so it is testable without a real scroller.
   *
   * @returns {{ markProgrammatic: (target: number, current: number) => void, onScroll: (observed?: number) => boolean }}
   */
  CX.scrollGuard = function () {
    var TOLERANCE = 1;
    var expected = null;
    return {
      markProgrammatic: function (target, current) {
        expected = Math.abs(target - current) <= TOLERANCE ? null : target;
      },
      onScroll: function (observed) {
        var target = expected;
        expected = null;
        if (target === null || typeof observed !== 'number') return true;
        return Math.abs(observed - target) > TOLERANCE;
      },
    };
  };

  /**
   * ADR 0017 residual, found by the private QC screenshot harness's H8 step: the lane's one-time
   * initial centring is measured from whatever layout is live at the first ResizeObserver
   * callback, which can land before a webfont swap finishes reflowing the chip labels -- freezing
   * a scrollLeft a few pixels off the position the same layout would produce with final fonts.
   * Called once, from the initial render only, this re-measures after `document.fonts.ready`
   * resolves and applies the corrected position -- but only if isSettled() still says nothing has
   * moved the lane on from that initial render (a later render for any reason, or a scroll, click
   * or keyboard interaction -- never yank a position the reader already chose). Never smooth
   * -scrolls, matching the initial centring's own "always instant" rule; reduced-motion has no
   * bearing on a position, only on an animation.
   *
   * Pure orchestration -- takes its DOM access as callbacks, so it is testable with plain stub
   * objects instead of a real document.fonts/ResizeObserver.
   *
   * @param {{ ready?: Promise<any> } | undefined} fontsObj document.fonts, or undefined/absent
   * @param {() => boolean} isSettled true once the lane should no longer be auto-corrected
   * @param {() => (number | null)} measure the fresh centring position, or null (mirrors
   *   CX.centerScrollLeft's own contract -- nothing to scroll)
   * @param {(scrollLeft: number) => void} apply assigns the scroll position
   */
  CX.recentreOnFontsReady = function (fontsObj, isSettled, measure, apply) {
    if (!fontsObj || !fontsObj.ready || typeof fontsObj.ready.then !== 'function') return;
    fontsObj.ready.then(function () {
      if (isSettled()) return;
      var sl = measure();
      if (sl !== null) apply(sl);
    });
  };

  /**
   * The lane's aria-label promises "Use arrow keys to move between points" (FR-C2). Given the
   * currently-focused stud's index and the total stud count, returns the new index for a
   * keydown's `key`, clamped to [0, count-1], or the unchanged `current` for any other key.
   * Pure so it is testable without a real DOM.
   *
   * @param {number} current
   * @param {number} count
   * @param {string} key a KeyboardEvent.key value
   * @returns {number}
   */
  CX.roam = function (current, count, key) {
    if (count <= 0) return current;
    var j;
    if (key === 'Home') {
      j = 0;
    } else if (key === 'End') {
      j = count - 1;
    } else {
      var delta = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : null;
      if (delta === null) return current;
      j = current + delta;
    }
    return Math.max(0, Math.min(count - 1, j));
  };

  // -- PC tabs (issue #51) -----------------------------------------------------------------

  var PT = {};

  /**
   * The .tab-bar's scrollLeft that brings [tabLeft, tabLeft+tabWidth) fully into view with the
   * minimal scroll -- mirrors Element.scrollIntoView({inline:'nearest'})'s own inline-axis
   * semantics, but as a pure function over plain numbers (CX.centerScrollLeft's own pattern for
   * exactly the same reason: testable without a real layout engine, and the DOM caller assigns
   * the result directly to scrollLeft rather than animating an initial/corrected position). null
   * when the tab is already fully visible at `scrollLeft` (nothing to do) or the bar doesn't
   * overflow at all.
   *
   * @param {number} tabLeft the tab's own offsetLeft within the bar
   * @param {number} tabWidth the tab's own offsetWidth
   * @param {number} clientWidth the bar's own clientWidth
   * @param {number} scrollWidth the bar's own scrollWidth
   * @param {number} scrollLeft the bar's own current scrollLeft
   * @returns {number | null}
   */
  PT.nearestScrollLeft = function (tabLeft, tabWidth, clientWidth, scrollWidth, scrollLeft) {
    if (scrollWidth <= clientWidth) return null;
    var max = scrollWidth - clientWidth;
    var visibleLeft = tabLeft - scrollLeft;
    var visibleRight = visibleLeft + tabWidth;
    var target;
    if (visibleLeft < 0) {
      target = tabLeft;
    } else if (visibleRight > clientWidth) {
      target = tabLeft + tabWidth - clientWidth;
    } else {
      return null;
    }
    return Math.max(0, Math.min(max, target));
  };

  // initPcTabs (defined further down, in the DOM-boot section) is a hoisted function
  // declaration, so referencing it here -- above its own textual definition, but still inside
  // the same enclosing IIFE -- is valid: the whole function body is hoisted, not just its name.
  // Exported so Reviewer CORRECTIONS' scroll-guard test can invoke the real function against a
  // hand-built fake .tab-bar, rather than re-deriving its wiring by hand in the test (which a
  // Reviewer pass correctly flagged: a hand-rolled re-implementation can drift from what
  // initPcTabs actually does and stay green after a real regression). No runtime behaviour
  // change: bootPcTabs still calls the same initPcTabs directly, this only adds a second,
  // additional reference to the same function.
  PT.initPcTabs = initPcTabs;

  if (typeof module === 'object' && module.exports) {
    module.exports = { TL: TL, CX: CX, PT: PT };
    return;
  }

  // ================================================================================
  // DOM boot
  // ================================================================================

  function boot() {
    bootTimelines();
    bootConnections();
    bootPcTabs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  var RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // -- Timeline ---------------------------------------------------------------------

  function initTimeline(root) {
    var dataEl = root.parentElement.querySelector('.sc-tl-data');
    if (!dataEl) return;
    var data = JSON.parse(dataEl.textContent);
    var V = TL.vocab(data.voc);
    var hasLearned = data.learned.length > 0;
    var mq = window.matchMedia ? matchMedia('(max-width: 700px)') : { matches: false };
    var st = { lens: false, open: null };

    function render() {
      var P = TL.points(data, st.lens, V);
      var L = TL.layout(P, data.segs);
      root.className = 'sc-tl' + (mq.matches ? ' sc-tl-is-phone' : '');

      var top = TL.lensBar(st.lens, hasLearned, V);

      var body;
      if (mq.matches) {
        body = renderSpine(L, data);
      } else {
        body = renderRuler(L, data);
      }
      root.innerHTML = top + body;
      wireTimeline(root, data, L, st, render, mq, V);
      var src = root.parentElement.querySelectorAll('.sc-tl-src');
      for (var i = 0; i < src.length; i++) src[i].hidden = true;
    }

    function renderRuler(L, data) {
      var h = '';
      // Tier groups: consecutive segments sharing the same tier, drawn as one wider band below
      // the segment-level (t2) labels, matching tl-work/leaf.css's #stl .stl-t1 (a "book leaves"
      // brass-heading treatment) sitting under the italic, muted t2 segment labels.
      var groups = [];
      data.segs.forEach(function (s) {
        var g = groups.length ? groups[groups.length - 1] : null;
        if (g && g.tier === s.tier) {
          g.end = s.id;
        } else {
          groups.push({ tier: s.tier, start: s.id, end: s.id });
        }
      });
      data.segs.forEach(function (s) {
        h += '<div class="sc-tl-tick" style="left:' + L.segX[s.id] + 'px"></div>';
        h += '<div class="sc-tl-t2" style="left:' + (L.segX[s.id] + 8) + 'px;max-width:' + (L.segW[s.id] - 12) + 'px">' + esc(s.label) + '</div>';
      });
      groups.forEach(function (g, gi) {
        var left = L.segX[g.start];
        var width = L.segX[g.end] + L.segW[g.end] - left;
        h += '<div class="sc-tl-t1" style="left:' + left + 'px;width:' + width + 'px"><span>' + (gi > 0 ? '<i class="sc-tl-fleuron" aria-hidden="true">&#10086;</i> ' : '') + esc(g.tier) + '</span></div>';
      });
      h += '<div class="sc-tl-line" style="top:' + TL.LINE + 'px"></div>';
      h += '<div class="sc-tl-break" style="left:' + (TL.BEFORE_W - 10) + 'px;top:' + (TL.LINE - 9) + 'px" aria-hidden="true"></div>';
      var k = 0;
      L.points.forEach(function (p) {
        if (p.ghost) {
          h += '<span class="sc-tl-ghost" style="left:' + p._x + 'px;top:' + TL.LINE + 'px" aria-hidden="true"></span>';
          return;
        }
        var lane = k++ % 3, ty = 6 + lane * 50;
        h +=
          '<div class="sc-tl-rp" style="left:' + p._x + 'px">' +
          '<span class="sc-tl-rt" style="top:' + ty + 'px">' + esc(p.t) + '</span>' +
          '<span class="sc-tl-stem" style="top:' + (ty + 44) + 'px;height:' + (TL.LINE - ty - 56) + 'px"></span>' +
          '<button type="button" class="sc-tl-mk" data-id="' + p.id + '" style="top:' + TL.LINE + 'px" aria-label="' + esc(p.t + ', ' + p.when) + '">' + TL.marker(p, V) + '</button></div>';
      });
      var ov =
        '<div class="sc-tl-ov" aria-label="Jump to">' +
        data.segs
          .map(function (s) {
            return '<button type="button" data-seg="' + s.id + '" style="flex-grow:' + L.segW[s.id] + '"><span>' + esc(s.label) + '</span></button>';
          })
          .join('') +
        '<i class="sc-tl-win"></i></div>';
      return (
        '<div class="sc-tl-ruler">' + ov +
        '<div class="sc-tl-pan"><button type="button" class="sc-tl-pb" data-pan="-1" aria-label="Earlier">&lsaquo;</button>' +
        '<div class="sc-tl-scroll"><div class="sc-tl-track" style="width:' + L.width + 'px;height:' + TL.H + 'px">' + h + '</div></div>' +
        '<button type="button" class="sc-tl-pb" data-pan="1" aria-label="Later">&rsaquo;</button></div></div>' +
        '<div class="sc-tl-card" role="dialog" aria-modal="false" hidden><button type="button" class="sc-tl-x" aria-label="Close">&times;</button><div class="sc-tl-cb"></div></div>'
      );
    }

    function renderSpine(L, data) {
      var h = '<ol class="sc-tl-spine">';
      var lastSeg = null;
      L.points.forEach(function (p) {
        var seg = data.segs.filter(function (s) { return s.id === p.seg; })[0];
        var first = p.seg !== lastSeg;
        lastSeg = p.seg;
        var segLabel = first ? '<div class="sc-tl-sl"><b>' + esc(seg.tier) + '</b>' + (seg.before ? '' : ' <i>' + esc(seg.label) + '</i>') + '</div>' : '';
        if (p.ghost) {
          h += '<li class="sc-tl-row sc-tl-is-ghost' + (first ? ' sc-tl-is-first' : '') + '" aria-hidden="true"><div class="sc-tl-margin">' + segLabel + '</div><div class="sc-tl-rail"><span class="sc-tl-ghost"></span></div><div class="sc-tl-body"><span class="sc-tl-gt">' + esc(p.t) + '</span></div></li>';
          return;
        }
        h +=
          '<li class="sc-tl-row' + (first ? ' sc-tl-is-first' : '') + '" data-row="' + p.id + '">' +
          '<div class="sc-tl-margin">' + segLabel + '</div>' +
          '<div class="sc-tl-rail"><button type="button" class="sc-tl-mk" data-id="' + p.id + '" aria-label="' + esc(p.t + ', ' + p.when) + '">' + TL.marker(p, V) + '</button></div>' +
          '<div class="sc-tl-body"><p class="sc-tl-when">' + esc(p.when) + '</p><h3 class="sc-tl-st">' + esc(p.t) + '</h3></div></li>';
      });
      return (
        h + '</ol>' +
        '<div class="sc-tl-card" role="dialog" aria-modal="false" hidden><button type="button" class="sc-tl-x" aria-label="Close">&times;</button><div class="sc-tl-cb"></div></div>'
      );
    }

    render();
    mq.addEventListener ? mq.addEventListener('change', render) : mq.addListener(render);
    window.addEventListener('pageswap', function () {
      closeCard(root, st, false);
    });
  }

  function closeCard(root, st, returnFocus) {
    var card = root.querySelector('.sc-tl-card');
    if (!card || card.hidden) return;
    card.hidden = true;
    var b = root.querySelector('[data-id="' + st.open + '"]');
    if (b) b.classList.remove('sc-tl-is-sel');
    st.open = null;
    if (returnFocus && b) b.focus();
  }

  function wireTimeline(root, data, L, st, render, mq, V) {
    var byId = {};
    L.points.forEach(function (p) { byId[p.id] = p; });

    function select(id, user) {
      var p = byId[id];
      if (!p) return;
      var card = root.querySelector('.sc-tl-card');
      if (!card) return;
      if (st.open === id) {
        closeCard(root, st, false);
        return;
      }
      card.querySelector('.sc-tl-cb').innerHTML = TL.cardBody(p, data, V);
      card.hidden = false;
      card.classList.toggle('sc-tl-is-sheet', mq.matches);
      root.querySelectorAll('[data-id]').forEach(function (b) {
        b.classList.toggle('sc-tl-is-sel', b.getAttribute('data-id') === id);
      });
      st.open = id;
      if (user && mq.matches) {
        var x = card.querySelector('.sc-tl-x');
        if (x) x.focus();
      }
    }

    root.querySelectorAll('[data-lens]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-lens') === '1';
        if (v === st.lens) return;
        st.lens = v;
        render();
        var nb = root.querySelector('[data-lens="' + (v ? 1 : 0) + '"]');
        if (nb) nb.focus();
      });
    });

    root.querySelectorAll('button[data-id]').forEach(function (b) {
      b.addEventListener('click', function () {
        select(b.getAttribute('data-id'), true);
      });
    });

    root.querySelectorAll('.sc-tl-x').forEach(function (b) {
      b.addEventListener('click', function () {
        closeCard(root, st, true);
      });
    });

    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeCard(root, st, true);
        return;
      }
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var t = e.target.closest && e.target.closest('[data-id]');
      if (!t) return;
      var all = Array.prototype.slice.call(root.querySelectorAll('button[data-id]'));
      var i = all.indexOf(t) + ((e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1);
      if (all[i]) {
        e.preventDefault();
        all[i].focus();
        select(all[i].getAttribute('data-id'), false);
      }
    });

    document.addEventListener('click', function (e) {
      var card = root.querySelector('.sc-tl-card');
      if (!card || card.hidden) return;
      if (!e.target.closest || (!e.target.closest('.sc-tl-card') && !e.target.closest('button[data-id]'))) {
        closeCard(root, st, false);
      }
    });

    var sc = root.querySelector('.sc-tl-scroll');
    if (sc) {
      root.querySelectorAll('[data-pan]').forEach(function (b) {
        b.addEventListener('click', function () {
          sc.scrollBy({ left: +b.getAttribute('data-pan') * sc.clientWidth * 0.8, behavior: RM.matches ? 'auto' : 'smooth' });
        });
      });
      root.querySelectorAll('[data-seg]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-seg');
          var p0 = L.points.filter(function (p) { return p.seg === id && !p.ghost; })[0];
          if (p0) sc.scrollTo({ left: Math.max(0, p0._x - 60), behavior: RM.matches ? 'auto' : 'smooth' });
        });
      });
    }
  }

  function bootTimelines() {
    var roots = document.querySelectorAll('.sc-tl');
    for (var i = 0; i < roots.length; i++) {
      try {
        initTimeline(roots[i]);
      } catch (e) {
        // leaves the static markup in place
      }
    }
  }

  // -- Connections --------------------------------------------------------------------

  var CX_ICON = {
    pc: 'M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4z',
    npc: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5',
    faction: 'M4 1.5v13M4 2.2h8.5l-2 3 2 3H4',
    location: 'M4 14.5V6l4-3.2L12 6v8.5zM7 14.5v-3h2v3M2.5 14.5h11',
    item: 'M8 1.5l5 6.5-5 6.5-5-6.5zM3 8h10',
    creature: 'M4 13.5c0-4 1-7.5 3-10.5M8 14c0-4 .6-7.5 2.2-10.5M11.6 13.4c0-3 .5-5.4 1.9-7.4',
    event: 'M8 1.5l1.8 4.2 4.5.4-3.4 3 1 4.4L8 11.2l-3.9 2.3 1-4.4-3.4-3 4.5-.4z',
    heritage: 'M3 13C3 6 7 3 13 3c0 6-3 10-10 10zM3 13l6-6',
    other: 'M8 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  };
  function cxIcon(t) {
    return '<svg class="sc-cx-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="' + (CX_ICON[t] || CX_ICON.other) + '"/></svg>';
  }

  function trayLine(it, data) {
    if (it.kind === 'tie') return 'Declared on this page';
    if (it.kind === 'named') return 'Declared on ' + esc(it.name) + '’s page';
    return 'What ' + esc(it.name) + '’s page says';
  }
  // A tie/named line is a raw frontmatter description; its author sometimes already wrote it as
  // a quote. Wrapping an already-quoted string in <q> doubles the marks (the tray showed
  // literal-then-UA-rendered quotes back to back). Strip one matching leading/trailing pair
  // (straight or curly) before <q> adds its own, so the text stays verbatim otherwise.
  function stripWrappingQuotes(s) {
    var pairs = [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']];
    for (var i = 0; i < pairs.length; i++) {
      if (s.charAt(0) === pairs[i][0] && s.charAt(s.length - 1) === pairs[i][1] && s.length > 1) {
        return s.slice(1, -1);
      }
    }
    return s;
  }
  function traySay(it, data) {
    if (it.line) return '<q>' + esc(stripWrappingQuotes(it.line)) + '</q>';
    if (it.kind === 'mention') return 'Mentions ' + esc(data.name) + ' by link.';
    return '';
  }

  function tray(sel, data, V) {
    if (!sel) return '<div class="sc-cx-tray" aria-live="polite"></div>';
    return (
      '<div class="sc-cx-tray" aria-live="polite"><div class="sc-cx-tray-h">' +
      (sel.href ? '<a href="' + esc(sel.href) + '">' + esc(sel.name) + '</a>' : '<span>' + esc(sel.name) + '</span>') +
      '</div><p class="sc-cx-tray-src">' + trayLine(sel, data) + '</p><p class="sc-cx-tray-say">' + traySay(sel, data) + '</p>' + CX.traySame(sel, data, V) + '</div>'
    );
  }

  function initConnections(section) {
    var dataEl = section.querySelector('.sc-cx-data');
    if (!dataEl) return;
    var data = JSON.parse(dataEl.textContent);
    var V = CX.vocab(data.voc);
    var showAll = false;
    var sel = null;
    // lane-centre-fix (ADR 0017 residual): tracks whether the reader has moved the lane on from
    // its own initial render -- a scroll, a click/"show more", or a keyboard roam -- so the
    // one-time post-fonts recentre below never yanks a position they chose themselves. renderGen
    // is the same "still in the initial state" signal for a re-render triggered any other way
    // (e.g. a cap-changing resize): CX.recentreOnFontsReady's own isSettled() checks both.
    var interacted = false;
    var scrollGuard = CX.scrollGuard();
    var renderGen = 0;
    var fontsHooked = false;

    // Mirrors the timeline's own pattern (initTimeline's `root` is a dedicated element the
    // .sc-tl-src tables never live inside, so its own innerHTML rebuild can never destroy them):
    // a live-render mount, inserted once as a sibling of .sc-cx-static rather than reusing
    // section.innerHTML for the whole section. That previously destroyed .sc-cx-static on the
    // very first render, making the "hide the static fallback" line below it dead code.
    var liveMount = document.createElement('div');
    liveMount.className = 'sc-cx-live';
    var staticAnchor = section.querySelector('.sc-cx-static');
    if (staticAnchor) section.insertBefore(liveMount, staticAnchor);
    else section.appendChild(liveMount);

    function render(centerHub) {
      var width = section.clientWidth;
      if (!width) return; // journey reveal: do not render at width 0
      renderGen++;
      var cap = CX.capFor(width);
      var vis = CX.visible(data.items, cap, showAll);
      if (!sel) sel = CX.restItem(vis);

      var byGroup = {};
      CX.GROUP_ORDER.forEach(function (g) { byGroup[g] = []; });
      vis.forEach(function (it) {
        if (!byGroup[it.group]) byGroup[it.group] = [];
        byGroup[it.group].push(it);
      });

      var hubHtml =
        '<div class="sc-cx-hub"><div class="sc-cx-hub-seal" aria-hidden="true">' +
        esc(data.seal) +
        '</div><div class="sc-cx-hub-name">' +
        esc(data.name) +
        '</div>' +
        CX.hubSess(data, V) +
        '</div>';

      // FR-C2/AC-12 (a1 lane): declared ties + "Named by" on the left, the hub in the middle,
      // mentions grouped on the right -- LEFT_GROUPS/RIGHT_GROUPS below is the "side" split.
      // Under 600px of container the CSS alone reflows this same DOM into the vertical spine
      // (FR-C5); no separate markup is built for that case.
      var gi = 0;
      function renderSeg(g) {
        var items = byGroup[g];
        if (!items.length) return '';
        var fleuron = gi > 0 ? '<i class="sc-cx-fleuron" aria-hidden="true">&#10086;</i> ' : '';
        gi++;
        var seg = '<div class="sc-cx-seg"><h3 class="sc-cx-gh">' + fleuron + esc(CX.groupTitle(g, V)) + '<small>' + items.length + '</small></h3><ul class="sc-cx-list">';
        items.forEach(function (it) {
          var idx = data.items.indexOf(it);
          var target = it.href ? '<a href="' + esc(it.href) + '" data-i="' + idx + '">' + esc(it.name) + '</a>' : '<span class="sc-cx-nolink" data-i="' + idx + '" tabindex="0">' + esc(it.name) + '</span>';
          var rel = it.rel ? ' <span class="sc-cx-rel">' + esc(it.rel) + '</span>' : '';
          seg += '<li class="sc-cx-kind-' + it.kind + '"><button type="button" class="sc-cx-stud" data-i="' + idx + '" aria-pressed="' + (it === sel) + '">' + cxIcon(it.type) + '</button><span class="sc-cx-lbl">' + target + rel + '</span></li>';
        });
        return seg + '</ul></div>';
      }
      var leftHtml = CX.LEFT_GROUPS.map(renderSeg).join('');
      var rightHtml = CX.RIGHT_GROUPS.map(renderSeg).join('');

      var hidden = data.items.length - vis.length;
      var moreHtml = '';
      if (hidden > 0) moreHtml = '<button type="button" class="sc-cx-more" data-more>Show ' + hidden + ' more</button>';
      else if (showAll && data.items.length > cap) moreHtml = '<button type="button" class="sc-cx-more" data-more>Show fewer</button>';

      var body =
        '<div class="sc-cx-side" aria-hidden="true"><span>Declared here</span><span>Mentioned elsewhere</span></div>' +
        '<div class="sc-cx-lane-scroll"><div class="sc-cx-lane" role="group" aria-label="Connections of ' + esc(data.name) + '. Use arrow keys to move between points.">' +
        leftHtml + hubHtml + rightHtml +
        '</div></div>' +
        moreHtml +
        tray(sel, data, V);

      liveMount.innerHTML = body;
      wireConnections(section, data, render, function (it) { sel = it; }, function () { return showAll; }, function (v) { showAll = v; }, V, function () { interacted = true; });

      // On initial layout (first render at this width, or the first render after a hidden-tab
      // reveal/#journey deep link) a lane wider than its container starts centred on the hub,
      // matching the mock -- never on a re-render from user interaction (selecting an item,
      // "Show more"), which would otherwise yank a scroll position the user just set themselves.
      if (centerHub) {
        var scroller = section.querySelector('.sc-cx-lane-scroll');
        var hubEl = section.querySelector('.sc-cx-hub');
        if (scroller && hubEl) {
          var sl = CX.centerScrollLeft(hubEl.offsetLeft, hubEl.offsetWidth, scroller.clientWidth, scroller.scrollWidth);
          if (sl !== null) {
            scrollGuard.markProgrammatic(sl, scroller.scrollLeft);
            scroller.scrollLeft = sl; // direct assignment: always instant, never smooth
          }
          scroller.addEventListener('scroll', function () {
            if (scrollGuard.onScroll(scroller.scrollLeft)) interacted = true;
          });
        }

        // The lane's widths can still change after this: a webfont swap lands after this first
        // callback and reflows the chip labels (ADR 0017 residual, found by the private QC
        // screenshot harness's H8 step). Re-measure once fonts are actually final and correct the
        // position -- once only, and only if isSettled() still says nothing else has moved the
        // lane on since (a scroll/click/roam, or any other render, e.g. a cap-changing resize).
        if (!fontsHooked) {
          fontsHooked = true;
          var settledGen = renderGen;
          CX.recentreOnFontsReady(
            document.fonts,
            function () { return interacted || renderGen !== settledGen; },
            function () {
              var sc = section.querySelector('.sc-cx-lane-scroll');
              var hub = section.querySelector('.sc-cx-hub');
              if (!sc || !hub) return null;
              return CX.centerScrollLeft(hub.offsetLeft, hub.offsetWidth, sc.clientWidth, sc.scrollWidth);
            },
            function (v) {
              var sc = section.querySelector('.sc-cx-lane-scroll');
              if (!sc) return;
              scrollGuard.markProgrammatic(v, sc.scrollLeft);
              sc.scrollLeft = v;
            }
          );
        }
      }

      var staticEl = section.querySelector('.sc-cx-static');
      if (staticEl) staticEl.hidden = true;
    }

    var lastWidth = 0;
    var lastCap = null;
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        var w = section.clientWidth;
        if (w === 0) return; // hidden tab: never render at width 0
        var cap = CX.capFor(w);
        var isInitial = lastWidth === 0;
        if (isInitial || cap !== lastCap) {
          lastWidth = w;
          lastCap = cap;
          render(isInitial);
        }
      }).observe(section);
    } else {
      render(true);
    }
  }

  // Updates only the tray and the studs' aria-pressed state for a new selection, without the
  // full section.innerHTML rebuild render() does -- a keyboard-driven selection needs to keep
  // focus on the stud that just received it, which a full rebuild would destroy.
  function applyCxSelection(section, data, sel, V) {
    var studs = section.querySelectorAll('.sc-cx-stud');
    for (var k = 0; k < studs.length; k++) {
      var it = data.items[+studs[k].getAttribute('data-i')];
      studs[k].setAttribute('aria-pressed', it === sel ? 'true' : 'false');
    }
    var trayEl = section.querySelector('.sc-cx-tray');
    if (trayEl) trayEl.outerHTML = tray(sel, data, V);
  }

  function wireConnections(section, data, render, setSel, getShowAll, setShowAll, V, markInteracted) {
    section.addEventListener('click', function (e) {
      var more = e.target.closest && e.target.closest('[data-more]');
      if (more) {
        markInteracted();
        setShowAll(!getShowAll());
        render();
        return;
      }
      var t = e.target.closest && e.target.closest('[data-i]');
      if (t) {
        markInteracted();
        setSel(data.items[+t.getAttribute('data-i')]);
        render();
      }
    });

    // FR-C2's own aria-label promises it ("Use arrow keys to move between points"): roam the
    // studs with the arrows, Home/End jump to the first/last (mirrors the timeline's pattern at
    // this file's initTimeline/onKey, plus Home/End from the mock, conn-work/cx.js's own
    // keydown handler).
    section.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;

      var studs = Array.prototype.slice.call(section.querySelectorAll('.sc-cx-stud'));
      if (!studs.length) return;
      var t = e.target.closest && e.target.closest('.sc-cx-stud');
      var i = t ? studs.indexOf(t) : -1;
      if (i < 0) return;

      var j = CX.roam(i, studs.length, e.key);
      if (j === i) return;

      e.preventDefault();
      markInteracted();
      var next = studs[j];
      next.focus();
      var nextItem = data.items[+next.getAttribute('data-i')];
      setSel(nextItem);
      applyCxSelection(section, data, nextItem, V);
      next.scrollIntoView({ block: 'nearest', inline: 'center', behavior: RM.matches ? 'auto' : 'smooth' });
    });
  }

  function bootConnections() {
    var sections = document.querySelectorAll('.sc-cx');
    for (var i = 0; i < sections.length; i++) {
      try {
        initConnections(sections[i]);
      } catch (e) {
        // leaves the static markup in place
      }
    }
  }

  // -- PC tabs (issue #51) -----------------------------------------------------------
  //
  // .tab-bar/.pc-tab/switchTab() are the pin's own (node_modules/gm-apprentice-publish's
  // lib/templates/pc.js, an inline <script> in every PC page -- not read or required from here,
  // per CLAUDE.md's facade rule). switchTab() toggles .active on click AND once on load, from an
  // inline IIFE that switches straight to location.hash's tab, but it never scrolls the newly
  // active button into view within .tab-bar's own overflow-x:auto strip (assets/site/
  // scriptorium.css's <=700px rule). A vault with enough tabs/label length to overflow at phone
  // width, landed on directly via a #story/#journey link from elsewhere, can select a tab whose
  // active-tab underline sits at or past the strip's visible edge with no affordance that more
  // is off-screen -- issue #51. This only ever scrolls .tab-bar itself (the sole horizontally
  // scrollable ancestor .pc-tab has), never the page.
  //
  // Same webfont-swap race the QC harness's H8 step found and documented for the Connections
  // lane's own initial centring (CX.recentreOnFontsReady's own comment): a scroll position
  // measured at boot can be a few px off whatever the SAME layout produces once webfonts finish
  // swapping in, because tab label widths shift. Reusing CX.recentreOnFontsReady (already
  // generic -- fontsObj/isSettled/measure/apply callbacks, nothing Connections-specific in its
  // own logic) re-measures once document.fonts.ready resolves, and applies the correction only
  // if nothing has moved the bar since (a click already re-settled it via scrollIntoView below).
  function initPcTabs(bar) {
    var active = bar.querySelector('.pc-tab.active');
    var settled = false;
    // Reviewer CORRECTIONS (issue #51): a hand-scroll of the strip before document.fonts.ready
    // resolves went uncaught (settled was only ever set by a click), so the one-time
    // recentreOnFontsReady correction below could still fire afterwards and silently snap the
    // strip back, overwriting a position the reader just chose. CX.scrollGuard (reused, not
    // copied -- the Connections lane's own initConnections pairs it with a scroll listener the
    // same way) distinguishes that real scroll from this function's own programmatic writes,
    // both of which must call markProgrammatic(value, bar.scrollLeft) immediately before assigning
    // bar.scrollLeft so their own resulting 'scroll' event isn't misread as a real interaction.
    // The guard compares positions, so a real scroll coalesced into one of those events is
    // still reported as real (issue #22).
    var scrollGuard = CX.scrollGuard();

    function place() {
      if (!active) return null;
      return PT.nearestScrollLeft(active.offsetLeft, active.offsetWidth, bar.clientWidth, bar.scrollWidth, bar.scrollLeft);
    }

    // Instant, not RM-gated: an initial/corrected position is not a user-triggered scroll, same
    // rule CX.centerScrollLeft's own comment states for the Connections lane.
    var sl = place();
    if (sl !== null) {
      scrollGuard.markProgrammatic(sl, bar.scrollLeft);
      bar.scrollLeft = sl;
    }

    bar.addEventListener('scroll', function () {
      if (scrollGuard.onScroll(bar.scrollLeft)) settled = true;
    });

    CX.recentreOnFontsReady(
      typeof document !== 'undefined' ? document.fonts : undefined,
      function () {
        return settled;
      },
      place,
      function (v) {
        scrollGuard.markProgrammatic(v, bar.scrollLeft);
        bar.scrollLeft = v;
      },
    );

    bar.addEventListener('click', function (e) {
      var tab = e.target.closest && e.target.closest('.pc-tab');
      if (!tab) return;
      settled = true;
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: RM.matches ? 'auto' : 'smooth' });
    });
  }

  function bootPcTabs() {
    var bars = document.querySelectorAll('.tab-bar');
    for (var i = 0; i < bars.length; i++) {
      try {
        initPcTabs(bars[i]);
      } catch (e) {
        // leaves the static markup in place
      }
    }
  }

  window.addEventListener('pageswap', function () {
    // handled per-timeline above; kept here as the single documented listener location.
  });
})();
