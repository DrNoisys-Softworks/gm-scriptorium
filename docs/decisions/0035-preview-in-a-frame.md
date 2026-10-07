# 0035. The panel shows the player site inside a frame

Status: proposed.

## Summary

The admin panel can now show your private preview site inside the panel itself, so you can see the
player site while you work. The browser allows this only for the panel's own page and only for the
preview address on the same computer and host name; nothing else can frame the preview, and nothing
can frame the panel. The framed site runs in a sandbox that can't open pop-ups, submit forms or take
over the window, and it can't reach the panel. The panel also says when the preview is out of date
because you saved something after the last build. It can't tell when a note in your vault was
edited outside the panel, and it says so.

## 1. Decision

Exactly one admin response, the panel's own page (`GET /`), gains a `frame-src` allowance naming
the preview address on this computer, `http://<host>:<preview port>`, and nothing else. Every
response the preview address itself sends gains a `frame-ancestors` header naming the panel's own
address the same way, so only the panel's own page can ever frame a preview page. Both fail closed:
if the request's own Host header is not exactly `127.0.0.1` or `localhost` on the expected port, or
the port in question is not a real one, the panel's page keeps its ordinary, unwidened policy and a
preview page refuses to be framed by anyone at all. Every frame the panel builds runs in a sandbox
that allows scripts and treats the framed page as its own origin, and nothing else, no pop-ups,
no top-level navigation, no form submission out of the frame.

## 2. Threat notes

- The framed page's address differs from the panel's own by port alone, and a browser treats a
  different port as a different origin. Even with scripts allowed inside the frame, that origin has
  no access to the panel's own page, its storage, or anything on it.
- The sandbox refuses pop-ups, top-level navigation, downloads and form submission from inside the
  frame. Clicking a link to somewhere else inside the framed page, or the GM link it carries back to
  the panel, shows the browser's own refusal rather than actually navigating.
- Another service already running on this computer's loopback address cannot frame the preview
  either, even though the browser would attach the same cookie to a request from it: the
  `frame-ancestors` header names the panel's own address specifically, and nothing else qualifies.
- The panel has no listener for a message from inside a frame, and never sends one. There is no
  channel for the framed page to talk back to the panel, or the other way around.
- A request the framed page makes back to the panel's own address carries the same cookie a browser
  always attaches to a same-site request, but that was already true the moment a GM opened the
  preview in an ordinary tab. It can read nothing (there is no cross-origin permission granted) and
  it changes nothing (every write still checks the exact page it was sent from). Framing the preview
  does not add or remove anything here.
- Everything ADR 0022's own threat model already covers, the loopback bind, the host allowlist,
  cookie handling, the absence of any cross-origin permission, is unchanged by this decision. This
  is a narrow addition to it, not a replacement.

## 3. How the cookie works inside the frame

The session cookie is host-only and ignores the port, so the same cookie a GM's browser holds for
the panel is also sent with a request to the preview address, on this same computer, whichever port
each one happens to be bound to. Framing the preview does not change this: opening the preview
address directly in a tab already relied on the identical mechanism. The frame's sandbox must allow
same-origin treatment for this to keep working, without it, the framed page's own requests for its
scripts, styles, images and search index would be treated as a different, opaque origin, the cookie
would be withheld from every one of them, and the framed page would fail to load its own pieces.
Granting same-origin treatment inside the sandbox does not grant the framed page anything about the
panel's own origin: the two remain different origins by port, exactly as described above.

## 4. How fresh the preview is

Each successful build takes a stamp, at the moment the build starts, of three things: the sha256 of
`pack.toml`, the sha256 of `vault.config.json`, and the sha256 of `_meta/vault-config.md`'s
frontmatter, the three files the panel itself can save, plus a running count of how many times
the panel has actually written one of them in this session. The panel compares that stamp against
the same three shas and the same count right now, and says the preview is out of date whenever
either has moved since the stamp was taken. When a save has happened but none of the three files
themselves moved, an image upload, say, the panel still says the preview is out of date, without
being able to name which of the three files is responsible, because none of them is.

The stamp is taken before the build runs, not after: an edit that lands while a build is already in
progress is still caught, because the comparison is against what the stamp recorded at the start,
not a snapshot the build itself happened to see partway through. A build that is refused, or that
fails outright, never replaces the stamp at all, the preview a GM is looking at has not changed,
so neither should the freshness signal describing it.

## 5. Which pages the pane offers

The pane's page picker, the landing page, the latest recap, a character page, and the timeline,
is built entirely by walking the preview's own built tree after a successful build, the same tree
the preview address itself serves. Nothing is remembered from earlier, and nothing is guessed from
the vault's own folder names: a role is only offered when the walk actually finds a page for it, and
every address the pane ever puts inside a frame is a path the walk itself found, so it can never be
an address outside that tree. The one exception is the character page, which additionally depends
on the site's own search index (present only when search is turned on for this campaign): the walk
reads that index's own list of pages and keeps only the entries that are also, independently, real
pages the walk found on disk, an index entry pointing somewhere the walk never saw is never
offered, however that mismatch came about.

## 6. Rejected alternatives

- **A screenshot, or a small headless browser bundled with the tool**, to show a static picture of
  the preview instead of a live frame. Rejected on the owner's own instruction, and it would also be
  a new runtime dependency, which this repository does not take on without saying so explicitly.
- **`frame-src` on every admin response**, the shape an earlier plan anticipated. Rejected as
  needlessly wide: only the panel's own single page ever frames anything, so only that one response
  needs the allowance, and every other response, including every JSON response, keeps the
  frozen policy exactly as it already is.
- **Naming both `127.0.0.1` and `localhost`, or a wildcard port, in either header.** Rejected: the
  request itself already says which of the two host forms a GM is using, so the header can always
  name exactly that one, no wider.
- **A sandbox without same-origin treatment for the framed page.** Rejected: without it, the cookie
  is withheld from the framed page's own subresource requests (section 3), and every one of them
  would be refused.
- **Writing the framed content with `srcdoc`, or as a `blob:` URL copy of the built page.** Rejected:
  neither is a same-origin document by default, both would still need the same-origin sandbox flag
  to work at all, and a page written that way would need every one of its relative links rewritten
  by hand to keep working.
- **`X-Frame-Options` instead of, or alongside, `frame-ancestors`.** Rejected: it cannot name a
  specific origin the way `frame-ancestors` can, only "deny" or "the same origin as this page",
  neither of which fits a preview that is meant to be framed by exactly one different origin.
- **Serving the preview through the panel's own origin**, so the two would share a CSP without any
  framing at all. Rejected outright: that would run vault-authored script on the panel's own origin,
  the exact thing ADR 0022's threat model forbids.
- **A message channel between the panel and the framed page**, to let the pane highlight something
  inside the frame or jump it to a spot on the page. Rejected: it is not needed for anything this
  slice builds, and it would be a new channel across the origin boundary this decision otherwise
  keeps closed.
- **Hashing the vault's own pages**, so an edit made outside the panel could also be caught.
  Rejected on cost: the owner accepted this as a residual rather than pay for hashing an entire
  vault on every freshness check.

## 7. Will catch

- A third-origin page attempting to frame the preview address: refused, in both a Chromium-family
  browser and Firefox.
- Any attempt to widen the frame allowance to name a host other than the exact one the request
  itself used.
- A stale preview after a save to any of the three tracked files, or after any other confirmed save
  the panel made.
- A refused or failed build leaving the freshness signal exactly where it was.
- A page role pointing outside the built tree, including one taken from a search index entry that
  does not correspond to a real, found page.
- A symlinked file or directory inside the built tree being offered as, or walked into for, a page
  role.

## 8. Will not catch, deliberately

- The GM link, and any other link inside a framed page pointing somewhere else, show the browser's
  own refusal when clicked inside the frame; opening the preview in its own tab still works exactly
  as before.
- Pop-ups, forms and downloads do not work from inside a frame. Opening the preview in a new tab
  does.
- An edit to a vault page made outside the panel is not reflected in the freshness signal; the panel
  says so, next to the signal itself.
- An edit made between one full-state read and the next is only noticed the next time the panel
  reads state again, not the instant it happens.
- A campaign with search turned off never offers a character page, because there is no search index
  to find one from.
- Frames are a real cost on a slow machine; nothing here works around that.
- The postcards are static-looking thumbnails, not something a GM can interact with directly; opening
  one large is how a GM actually reads it.

## 9. Evidence

- `src/admin/respond.js`: `adminShellCsp`, `previewFrameCsp`.
- `src/admin/gate.js`: `hostnameFor`.
- `src/admin/handlers/core.js`: `panelShell`.
- `src/admin/handlers/views.js`: `servePreview`, `previewHandler`, `state`.
- `src/admin/freshness.js`: `readTrackedShas`, `noteSaveIfWritten`, `takeStamp`, `compareStamp`.
- `src/admin/pageroles.js`: `resolvePageRoles`.
- `assets/admin/sitepane.js`: `PV.frameSrc`, the frame-building code path, and the sandbox literal.
- `test/admin-framing.test.js`, `test/admin-previewinfo.test.js`, `test/admin-pageroles.test.js`.

## Addendum: preview copies share the preview address

Copies of the site (`docs/decisions/0039-preview-copies.md`) are served from the same preview
address under a reserved prefix, and every response there carries the same `frame-ancestors`
header. The panel's `frame-src` allowance and the frame sandbox are unchanged. Every copy frame is
built by the same single code path as every other frame.
