'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const {
  ACCORDION_MARKER,
  transformAccordionOpen,
  applyAccordionOpen,
} = require('../src/build/accordions');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-accordions-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The exact pc.js:326-332 shape, two accordions (Background, Notes), verified against the
// pinned generator's real grix.html:104-113.
function grixShapedPage() {
  return `<!DOCTYPE html>
<html><head></head><body>
<main class="content">
<div class="accordion" id="background">
  <button class="accordion-header" aria-expanded="false" onclick="const o=this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',o)">Background</button>
  <div class="accordion-body">
    <p>Some background prose.</p>
  </div>
</div>
<div class="accordion" id="notes">
  <button class="accordion-header" aria-expanded="false" onclick="const o=this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',o)">Notes</button>
  <div class="accordion-body">
    <p>Some notes prose.</p>
  </div>
</div>
</main>
</body></html>`;
}

test('the grix-shaped pair both open, get aria-expanded="true" and the marker, id/whitespace preserved', () => {
  const html = grixShapedPage();
  const out = transformAccordionOpen(html);
  assert.notEqual(out, null);

  const occurrences = (out.match(/class="accordion open" id="background"/g) || []).length;
  assert.equal(occurrences, 1);
  assert.match(out, /class="accordion open" id="notes"/);
  assert.equal((out.match(/aria-expanded="true"/g) || []).length, 2);
  assert.equal((out.match(new RegExp(ACCORDION_MARKER, 'g')) || []).length, 2);
  assert.doesNotMatch(out, /aria-expanded="false"/);

  // Whitespace between the div open tag and the button is preserved byte-for-byte.
  assert.match(out, /<div class="accordion open" id="background">\n  <button/);

  // onclick toggle itself is untouched.
  assert.match(out, /onclick="const o=this\.parentElement\.classList\.toggle\('open'\);this\.setAttribute\('aria-expanded',o\)"/);
});

test('non-matching shape: already aria-expanded="true" is untouched', () => {
  const html = `<div class="accordion" id="x">
  <button class="accordion-header" aria-expanded="true" onclick="const o=this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',o)">X</button>
</div>`;
  assert.equal(transformAccordionOpen(html), null);
});

test('non-matching shape: a different onclick is untouched', () => {
  const html = `<div class="accordion" id="x">
  <button class="accordion-header" aria-expanded="false" onclick="doSomethingElse()">X</button>
</div>`;
  assert.equal(transformAccordionOpen(html), null);
});

test('non-matching shape: a bare accordion div with no header is untouched', () => {
  const html = `<div class="accordion" id="x"></div>`;
  assert.equal(transformAccordionOpen(html), null);
});

test('idempotent: a second pass returns null', () => {
  const once = transformAccordionOpen(grixShapedPage());
  assert.notEqual(once, null);
  assert.equal(transformAccordionOpen(once), null);
});

// Reviewer rework (B-2, 2026-09-24): the idempotency test above cannot, by itself, prove the
// marker guard does anything -- ACCORDION_RE only matches aria-expanded="false", which the
// transform always flips to "true", so a second real pass never re-matches regardless of whether
// the guard is even checked (recorded as a finding in the Engineer report). This fixture proves
// the guard directly: a page that already carries the marker (anywhere on the page, unrelated to
// any specific accordion) but STILL has a fresh, matchable aria-expanded="false" accordion.
// Without the guard, ACCORDION_RE would still match and transform it; with the guard, the whole
// page is left untouched because the marker-present check runs first.
test('a page that already carries the marker is left fully untouched, even with a still-matchable aria-expanded="false" accordion elsewhere', () => {
  const html = `<div ${ACCORDION_MARKER}></div>\n` + grixShapedPage();
  assert.equal(transformAccordionOpen(html), null);
  // Sanity: the same accordion HTML, without the marker present, IS matchable.
  assert.notEqual(transformAccordionOpen(grixShapedPage()), null);
});

// -- vm: the onclick toggle itself still folds/unfolds correctly ------------------------------

function makeFakeAccordion(initiallyOpen) {
  const classes = new Set(initiallyOpen ? ['accordion', 'open'] : ['accordion']);
  const button = {
    attrs: { 'aria-expanded': initiallyOpen ? 'true' : 'false' },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
  };
  const parentElement = {
    classList: {
      toggle(name) {
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        }
        classes.add(name);
        return true;
      },
      contains(name) {
        return classes.has(name);
      },
    },
  };
  button.parentElement = parentElement;
  return { button, parentElement };
}

// The onclick body, exactly as emitted (pc.js:327-328 / accordions.js's replacement), compiled
// via vm.Script into a real function and invoked with `button` as `this` -- so this is really
// evaluating the literal onclick source, not a hand-copied re-implementation of its behaviour.
const ONCLICK_SCRIPT = new vm.Script(
  "(function(){ const o=this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',o); })",
);

function runOnclick(button) {
  const fn = ONCLICK_SCRIPT.runInThisContext();
  fn.call(button);
}

test('vm: one click on an open accordion folds it (aria-expanded false, .open removed)', () => {
  const { button, parentElement } = makeFakeAccordion(true);
  runOnclick(button);
  assert.equal(parentElement.classList.contains('open'), false);
  assert.equal(button.attrs['aria-expanded'], 'false');
});

test('vm: a second click on the same accordion unfolds it again', () => {
  const { button, parentElement } = makeFakeAccordion(true);
  runOnclick(button); // fold
  runOnclick(button); // unfold
  assert.equal(parentElement.classList.contains('open'), true);
  assert.equal(button.attrs['aria-expanded'], 'true');
});

// -- applyAccordionOpen / walk ------------------------------------------------------------------

test('applyAccordionOpen patches every .html under siteRoot and counts accordions opened', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'grix.html'), grixShapedPage());
    fs.writeFileSync(path.join(dir, 'plain.html'), '<p>no accordions</p>');

    const result = applyAccordionOpen(dir);
    assert.equal(result.pagesPatched, 1);
    assert.equal(result.accordionsOpened, 2);

    const second = applyAccordionOpen(dir);
    assert.equal(second.pagesPatched, 0);
  });
});

// -- Mutation proofs (recorded manually in the Engineer report; this suite is the gate) -----------
// omit ' open' from the div's class attribute: the "both open" assertion (class="accordion open")
//   goes red.
// leave aria-expanded="false": the "aria-expanded true x2" / "doesNotMatch false" assertions go
//   red.
// drop the marker guard: the dedicated marker-guard fixture goes red (a page that already carries
//   the marker gets transformed anyway). Note (B-2 correction): dropping the guard does NOT turn
//   the idempotency test above red -- that test is idempotent by construction (ACCORDION_RE only
//   matches aria-expanded="false", which the transform always flips to "true", so a second real
//   pass can never re-match regardless of the guard). The dedicated fixture above is what actually
//   proves the guard; recorded here so this comment cannot make the same false claim again.
