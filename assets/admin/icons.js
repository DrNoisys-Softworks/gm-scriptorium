'use strict';

/*
 * Panel v2 V1a. IC: icon element specs, pure data (shared design 1.5), plus the browser
 * ScriptoriumAdmin.icon(name) built with createElementNS -- never via markup strings or any
 * DOM-injection sink (FR12; M:987-988's SVG-as-markup-string approach is exactly what's rejected
 * here).
 * Paths transcribed from shell.src.html:960-986, r2-src/common.js:10-13, r2-memory.html:755
 * (memory), r2-ai.html:542 (ai) and r2-transcribe.html:795 (mic, used for the sessions
 * placeholder). Every spec uses only IC.TAGS/IC.ATTRS (structural rule, 1.5), so the serialised
 * IC contains no "<".
 */
(function () {
  var TAGS = ['path', 'circle', 'rect', 'ellipse'];
  var ATTRS = ['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'fill', 'stroke'];

  var ICONS = {
    home: [
      ['path', { d: 'M4 11.5 12 5l8 6.5' }],
      ['path', { d: 'M6.5 10v9h11v-9' }],
    ],
    theme: [
      ['circle', { cx: '12', cy: '12', r: '7.5' }],
      ['path', { d: 'M12 4.5a7.5 7.5 0 0 0 0 15z', fill: 'currentColor', stroke: 'none' }],
    ],
    title: [['path', { d: 'M5 6.5h14M12 6.5V19M9 19h6' }]],
    images: [
      ['rect', { x: '3.5', y: '5', width: '17', height: '14', rx: '2' }],
      ['circle', { cx: '9', cy: '10', r: '1.7' }],
      ['path', { d: 'm20.5 15.5-4.5-4.5-8.5 8' }],
    ],
    vocab: [
      ['path', { d: 'M4 5.5h5.5A2.5 2.5 0 0 1 12 8v11a2 2 0 0 0-2-2H4z' }],
      ['path', { d: 'M20 5.5h-5.5A2.5 2.5 0 0 0 12 8v11a2 2 0 0 1 2-2h6z' }],
    ],
    memory: [
      ['path', { d: 'M7 4.5h10.5a2 2 0 0 1 2 2V17' }],
      ['path', { d: 'M5.5 4.5a2 2 0 0 0-2 2V8H7' }],
      ['path', { d: 'M7 4.5v13a2 2 0 0 0 2 2h9a2 2 0 0 0 1.5-2' }],
      ['path', { d: 'M10.5 9h6M10.5 12.5h6M10.5 16h3.5' }],
    ],
    check: [
      ['rect', { x: '5', y: '4', width: '14', height: '17', rx: '2' }],
      ['path', { d: 'm8.8 12.6 2.2 2.2 4.3-4.6' }],
    ],
    preview: [
      ['path', { d: 'M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z' }],
      ['circle', { cx: '12', cy: '12', r: '2.5' }],
    ],
    publish: [
      ['path', { d: 'M12 15V4.5M7.5 9 12 4.5 16.5 9' }],
      ['path', { d: 'M4.5 14.5v4a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-4' }],
    ],
    mic: [
      ['rect', { x: '9', y: '3.5', width: '6', height: '11', rx: '3' }],
      ['path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5M9 20.5h6' }],
    ],
    ai: [
      ['path', { d: 'M4.5 5.5h15v10.5h-8.5l-4.5 3.5v-3.5h-2z' }],
      ['path', { d: 'm8.5 9 2.2 1.8-2.2 1.8M12.8 12.6h3' }],
    ],
    storage: [
      ['ellipse', { cx: '12', cy: '6.5', rx: '7', ry: '2.8' }],
      ['path', { d: 'M5 6.5v11c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-11M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8' }],
    ],
    file: [
      ['path', { d: 'M6.5 3.5h7l4 4v13h-11z' }],
      ['path', { d: 'M13.5 3.5v4h4M9.5 13h5M9.5 16.5h5' }],
    ],
    more: [
      ['circle', { cx: '6', cy: '12', r: '1.3' }],
      ['circle', { cx: '12', cy: '12', r: '1.3' }],
      ['circle', { cx: '18', cy: '12', r: '1.3' }],
    ],
    // V1d-1 SD-4: transcribed from shell.src.html:960-986's ICO object -- the a1 component set
    // (buttons, pills, notes, the diff toggle) plus search/menu, added for the sidebar/n1 chrome.
    search: [
      ['circle', { cx: '11', cy: '11', r: '6' }],
      ['path', { d: 'm20 20-4.3-4.3' }],
    ],
    menu: [['path', { d: 'M4 7h16M4 12h16M4 17h16' }]],
    upload: [['path', { d: 'M12 15.5V5M7.5 9.5 12 5l4.5 4.5M5 19h14' }]],
    ext: [['path', { d: 'M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 14v5.5h-13v-13H10' }]],
    play: [['path', { d: 'M8 5.5v13l10-6.5z' }]],
    lock: [
      ['rect', { x: '5.5', y: '10.5', width: '13', height: '9.5', rx: '1.5' }],
      ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }],
    ],
    // V1e-9 (SD-105, r3-src/common.js:21): the editor's own unlock action (vc1's "Edit the file").
    unlock: [
      ['rect', { x: '5.5', y: '10.5', width: '13', height: '9.5', rx: '1.5' }],
      ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2' }],
    ],
    tick: [['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]],
    warn: [
      ['path', { d: 'M12 4 21 19.5H3z' }],
      ['path', { d: 'M12 10v4.5M12 17.2v.3' }],
    ],
    info: [
      ['circle', { cx: '12', cy: '12', r: '8' }],
      ['path', { d: 'M12 11v5M12 8v.3' }],
    ],
    // V1e-6: transcribed from r3-src/common.js:25 -- the Vocabulary "How to use" toolbar
    // button, rail and phone disclosure.
    help: [
      ['circle', { cx: '12', cy: '12', r: '8.5' }],
      ['path', { d: 'M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6M12 16.8v.3' }],
    ],
    x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    minus: [['path', { d: 'M5 12h14' }]],
    chev: [['path', { d: 'm9 6 6 6-6 6' }]],
    // chevd (the phone disclosure's open/closed state, r3-src/common.js:28) is defined once,
    // below, by V1e-4 -- both slices named it; V1e-4 landed on main first, so V1e-6 drops its
    // own duplicate here rather than keeping two entries for the same key.
    pencil: [
      ['path', { d: 'M4.5 19.5l1-4.6L15.6 4.8a2 2 0 0 1 2.8 0l.8.8a2 2 0 0 1 0 2.8L9.1 18.5z' }],
      ['path', { d: 'M13.7 6.7l3.6 3.6' }],
    ],
    swap: [['path', { d: 'M7 7h11l-3-3M17 17H6l3 3' }]],
    trash: [['path', { d: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12' }]],
    refresh: [
      ['path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }],
      ['path', { d: 'M19.5 4.5v4h-4' }],
    ],
    undo: [
      ['path', { d: 'M9 7 5 11l4 4' }],
      ['path', { d: 'M5 11h9a5 5 0 0 1 0 10h-2' }],
    ],
    // V1e-1 (SD-15): the combined review's .vc-bk "Backed up first" block (slip.js).
    archive: [
      ['rect', { x: '3.5', y: '4.5', width: '17', height: '4.5', rx: '1' }],
      ['path', { d: 'M5 9v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4' }],
    ],
    // V1e-4 (SD-28/SD-29): the Title screen's plain-words summary and site-details cards,
    // ported from panel-v3-mockups/r3-src/common.js:31-33,28.
    folder: [['path', { d: 'M3 7.2A1.7 1.7 0 0 1 4.7 5.5h4.1l2 2.2h8.5A1.7 1.7 0 0 1 21 9.4v8.9a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 18.3Z' }]],
    shield: [
      ['path', { d: 'M12 3.5 19 6v5.5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6Z' }],
      ['path', { d: 'm9 12 2.2 2.2L15.5 10' }],
    ],
    globe: [
      ['circle', { cx: '12', cy: '12', r: '8.5' }],
      ['path', { d: 'M3.5 12h17M12 3.5c2.4 2.6 3.5 5.5 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.5-3.5-8.5S9.6 6.1 12 3.5Z' }],
    ],
    chevd: [['path', { d: 'm6 9 6 6 6-6' }]],
    // V1e-3 (SD-23): sitepane.js's dock/edge-hide button (panel) and the device toggle
    // (desktop, phone). Transcribed from panel-v3-mockups/r3-src/common.js:36,44,45.
    panel: [
      ['rect', { x: '3.5', y: '4.5', width: '17', height: '15', rx: '1.8' }],
      ['path', { d: 'M14.5 4.5v15' }],
    ],
    desktop: [
      ['rect', { x: '3', y: '4.5', width: '18', height: '12', rx: '1.5' }],
      ['path', { d: 'M9 20h6M12 16.5V20' }],
    ],
    phone: [
      ['rect', { x: '7', y: '3', width: '10', height: '18', rx: '2' }],
      ['path', { d: 'M11 17.5h2' }],
    ],
    // V1e-5 (SD-59): the Images screen's size-line icon, transcribed from r3-src/common.js:50.
    frame: [
      ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '1' }],
      ['rect', { x: '7.5', y: '7.5', width: '9', height: '9' }],
    ],
    // V1e-7 (ADR 0039, SD-68): "Open full size" (expand) and the slip's before/after arrow.
    expand: [['path', { d: 'M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13.5 10.5M4.5 19.5l6-6' }]],
    arrow: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  };

  /*
   * V1b SD-11: timeline-kind glyphs, transcribed from assets/site/scriptorium.js's TL_GLYPH (its
   * 7 entries, as element specs using only IC.TAGS/IC.ATTRS) plus its PATH_DATA_RE and
   * src/build/labels.js's GLYPH_NAMES -- each copy has a drift test
   * (test/admin-write-drift.test.js). Stub only: the real specs land in the C3 commit.
   */
  var GLYPHS = {
    fight: [['path', { d: 'M4 4l10.5 10.5M16 4L5.5 14.5M11.6 16l4.4-4.4M4 11.6L8.4 16M14.5 14.5l2.3 2.3M5.5 14.5l-2.3 2.3' }]],
    meeting: [
      ['circle', { cx: '7', cy: '7.2', r: '2.5' }],
      ['circle', { cx: '13.4', cy: '7.2', r: '2.5' }],
      ['path', { d: 'M2.6 16.2c.6-2.9 2.3-4.4 4.4-4.4s3.8 1.5 4.4 4.4M9 16.2c.6-2.9 2.3-4.4 4.4-4.4s3.8 1.5 4.4 4.4' }],
    ],
    discovery: [
      ['path', { d: 'M2 10s3-5.4 8-5.4 8 5.4 8 5.4-3 5.4-8 5.4S2 10 2 10z' }],
      ['circle', { cx: '10', cy: '10', r: '2.3' }],
    ],
    journey: [
      ['circle', { cx: '10', cy: '10', r: '7' }],
      ['circle', { cx: '10', cy: '10', r: '1.5' }],
      [
        'path',
        {
          d: 'M10 3v5.5M10 11.5V17M3 10h5.5M11.5 10H17M5.1 5.1l3.8 3.8M11.1 11.1l3.8 3.8M14.9 5.1l-3.8 3.8M8.9 11.1l-3.8 3.8',
        },
      ],
    ],
    learned: [['path', { d: 'M10 5.6C8 4.3 5.5 4.1 3 4.6v10.2c2.5-.5 5-.3 7 1 2-1.3 4.5-1.5 7-1V4.6c-2.5-.5-5-.3-7 1zM10 5.6v10.2' }]],
    backstory: [['path', { d: 'M10 2.2l1.8 5.3 5.6.4-4.4 3.4 1.6 5.5L10 13.6l-4.6 3.2L7 11.3 2.6 7.9l5.6-.4z' }]],
    '': [['circle', { cx: '10', cy: '10', r: '3.5' }]],
  };
  var GLYPH_NAMES = ['backstory', 'discovery', 'fight', 'journey', 'learned', 'meeting'];
  var PATH_DATA_RE = /^[Mm][0-9MmZzLlHhVvCcSsQqTtAa.,+\-eE ]{0,1023}$/;

  var IC = { ICONS: ICONS, TAGS: TAGS, ATTRS: ATTRS, GLYPHS: GLYPHS, GLYPH_NAMES: GLYPH_NAMES, PATH_DATA_RE: PATH_DATA_RE };

  if (typeof module === 'object' && module.exports) {
    module.exports = { IC: IC };
    return;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * V1b SD-11: a glyph element, viewBox 0 0 20 20, stroke-width 1.4 (distinct from icon()'s 0 0
   * 24 24 / 1.7 -- glyphs are a separate visual language, the vocabulary editor's kind previews).
   * Stub only: real dispatch (name in GLYPH_NAMES / PATH_DATA_RE match / fallback) lands in C3.
   */
  function glyph(value) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'glyph');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    var spec;
    if (GLYPH_NAMES.indexOf(value) !== -1) {
      spec = GLYPHS[value];
    } else if (typeof value === 'string' && PATH_DATA_RE.test(value)) {
      spec = [['path', { d: value }]];
    } else {
      spec = GLYPHS[''];
    }
    spec.forEach(function (entry) {
      var tag = entry[0];
      var attrs = entry[1];
      var node = document.createElementNS(SVG_NS, tag);
      Object.keys(attrs).forEach(function (attr) {
        node.setAttribute(attr, attrs[attr]);
      });
      svg.appendChild(node);
    });
    return svg;
  }

  function icon(name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    var spec = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : [];
    spec.forEach(function (entry) {
      var tag = entry[0];
      var attrs = entry[1];
      var el = document.createElementNS(SVG_NS, tag);
      Object.keys(attrs).forEach(function (attr) {
        el.setAttribute(attr, attrs[attr]);
      });
      svg.appendChild(el);
    });
    return svg;
  }

  window.ScriptoriumAdmin = window.ScriptoriumAdmin || {};
  window.ScriptoriumAdmin.icon = icon;
  window.ScriptoriumAdmin.glyph = glyph;
})();
