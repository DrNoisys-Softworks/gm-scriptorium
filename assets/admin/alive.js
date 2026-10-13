'use strict';

/*
 * ADR 0028, section 11. The "stopped" tab. Every few seconds the page asks for a public asset
 * (HEAD /assets/favicon.svg). A public asset touches no session, so asking never extends or
 * refreshes anything: the lifetime of every session is unchanged. After two failures in a row
 * (the connection is refused, or the server answers 5xx) the page is replaced by the stopped page,
 * built with el()/setText() only.
 */
(function () {
  var A = window.ScriptoriumAdmin;
  if (!A) return;
  var INTERVAL_MS = 3000;
  var FAILURES_TO_STOP = 2;
  var failures = 0;
  var stopped = false;
  var timer = null;

  function showStopped() {
    stopped = true;
    if (timer !== null) window.clearInterval(timer);
    document.title = 'GM-Scriptorium · stopped';

    var main = A.el('main');
    main.className = 'stop';
    var crest = A.el('div');
    crest.className = 'a1-crest';
    var mark = A.el('span');
    A.setText(mark, 'GM');
    crest.appendChild(mark);
    var eyebrow = A.el('div');
    eyebrow.className = 'a1-eyebrow';
    A.setText(eyebrow, 'Backstage');
    var title = A.el('h1');
    title.className = 'stop-title';
    title.tabIndex = -1;
    A.setText(title, 'GM-Scriptorium has stopped');
    var why = A.el('p');
    var fine = A.el('p');
    fine.className = 'a1-fine';
    // One wording for every way the panel can stop (window closed, Ctrl+C, a signal, a service
    // manager): it names none of them. Mention a Start menu entry only once an installer adds one.
    A.setText(why, 'The panel and your preview are off. Everything you saved is on disk.');
    A.setText(fine, 'Start it again to carry on.');
    [crest, eyebrow, title, why, fine].forEach(function (n) {
      main.appendChild(n);
    });

    var body = document.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    body.setAttribute('data-page', 'stopped');
    body.appendChild(main);
    title.focus();
  }

  function poll() {
    if (stopped) return;
    var failed = function () {
      failures += 1;
      if (failures >= FAILURES_TO_STOP) showStopped();
    };
    A.api('/assets/favicon.svg', { method: 'HEAD', cache: 'no-store' }).then(function (res) {
      if (res.status >= 500) failed();
      else failures = 0;
    }, failed);
  }

  timer = window.setInterval(poll, INTERVAL_MS);
})();
