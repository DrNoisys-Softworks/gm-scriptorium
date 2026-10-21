# 0070. Keyboard focus is not left under the narrow window's bars

## Summary

In a window narrower than 700 px the panel keeps three things on screen while the page scrolls: the top bar, the bottom bar, and, on a screen with unsaved changes, the strip that holds Review and save. Pressing Tab or Shift+Tab could leave the focused control entirely under one of them. The page now carries CSS scroll padding equal to those bars, so the browser scrolls a focused control into the space between them. No bar moves, changes height or changes how it sticks. The Updates card's own narrow margin folds into the same padding, so that landing stays where it was.

Status: accepted. Builds on [ADR 0057](0057-windows-desktop-app.md) section 11 (the Updates card landing) and [ADR 0022](0022-gm-admin-panel.md) (the admin panel).

## 1. What was measured

A keyboard sweep drove every screen in real Chromium and Firefox at 390x844, 390x600 and 320x568, pressing Tab and then Shift+Tab through every focus stop and recording what was painted over each one.

- **The bars.** The top bar is 75 px tall. The bottom bar is 62 px. The unsaved-changes strip is 95.7 px at every size tried. At 320x568 the three together take 232.7 of the 568 px.
- **The size of the problem.** The sweep took 7751 focus stops, and 998 were entirely under a bar. In the 15 navigation screens in their base state, 124 were.
- **The cases that force it.** Each is reached by plain key presses from a fresh load, in both engines:
  - Title, Tab to "Site title": at 390x600 the box sat at 526 to 568 px with the strip starting at 442, and at 320x568 at 522 to 564 with the strip at 410. Firefox hid 45 px of it.
  - Title, Tab to "Landing tagline": at 390x844 the box sat at 706 to 796 px with the strip at 686.
  - Vocabulary, Tab to the "Show the file" summary: 35 px entirely under the strip, in all four combinations tried.
  - Overview, Shift+Tab to "Edit title and tagline", with the preview not built: at 390x844 the link sat at 50 to 72 px under the top bar, which ends at 75.

## 2. The decision

Below 700 px the `html` element gets `scroll-padding-top: 75px`, and `scroll-padding-bottom` of the bottom bar's height plus the bottom safe area. While the visible screen holds an unsaved-changes strip, the bottom value grows by 96 px. A `:has()` selector makes that last switch, so no script is involved. The 96 px is the measured 95.7 px rounded up. Nothing changes at 700 px and wider, where nothing sticks over the page.

## 3. How the browser uses it

Both engines treat the padded area as the place a focused control has to be. A control that is inside the window but inside the padded band counts as out of view, and the browser scrolls it out. The Title case shows this: with the page at the top, "Site title" is inside the window, yet entirely under the strip, so on main the browser did not scroll at all. With the padding it scrolls the page by about 290 px. That was shown by the forcing tests in this change and not assumed. After the change the forcing controls sit between the bars in both engines: for example "Site title" at 237 to 279 px at 390x600 in Chromium and 236 to 281 in Firefox, and the tagline at 331 to 421 and 335 to 425 at 390x844. "Edit title and tagline" lands at the top edge in Chromium (74.7 to 96.3 against a bar ending at 75) and mid-window in Firefox, so the two engines choose different alignments, which changes the rects and not the rule the tests apply.

## 4. The Updates landing

The Updates card used to carry a 91 px top margin below 700 px, the 75 px bar plus 16. With the page padding added, that would have stacked to 166 px. The margin is now 16 px everywhere, and the page's top padding supplies the rest, so the card's top still lands 16 px below the top bar. `focusCard` decides between centring the card and showing it from its top by comparing the card's height and margin with the room between the paddings, and not with the whole window. Without that change a 722 px card in a 760 px window is centred in a 623 px area and its top lands under the bar, and the existing landing test fails on exactly that.

The landing was measured again at the sizes of the earlier table, in both engines. Below 700 px wide, the tall-card cases at 390x600, 320x568 and 640x400 at 2x did not move. At 390x844 the card moved from 31 px to 16 px below the bar, since the card is now shown from its top there. At 699x844 the centred card moved from 117.5 to 86.5 px below the bar. At 1280x800 the card top (193.5 px, 193.2 px in Firefox) and the scroll position (875) did not move at all.

## 5. Rejected alternatives

- **A scroll margin on each element.** It would need hundreds of controls across 15 screens, and every new control would have to remember it. It does nothing for the bottom band unless it is repeated there.
- **A top bar that does not stick.** It is a visible change to the bar, and it leaves the fixed bottom bar and the strip, which caused most of the failures.
- **A focus listener that scrolls in script.** It repeats geometry the browser already owns and runs on every focus. It would also fight the Updates landing, which focuses its switch without scrolling so the page scrolls once.
- **Measuring the strip with a script.** It is exact, but it is more code for a strip that measured 95.7 px at every size. It is the remedy if a taller strip turns up.
- **Top padding only.** It leaves every failure in the bottom band.

## 6. Limits

Will catch: the forcing controls above, at both edges, in Chromium and Firefox.

Will not catch, deliberately:

- A strip taller than 96 px, for example a long list of changes on Images.
- The More sheet, the campaign switcher and the "tab out of date" banner. In a sweep after this change, every focus stop that is still entirely under a bar is in one of those three states, and none are under the top bar, bottom bar or strip anywhere else. Whether those open pieces should close when focus leaves them, or move, is an owner decision and is not made here.
- Controls that are only partly hidden (WCAG 2.2 AAA 2.4.12). A few remain, by a pixel or two.
- A browser without `:has()`. It falls back to the bar-only bottom value, so the strip case returns.
- A change to the top bar's height. The 75 px has to be changed with it. The test for the top edge reads the live bar and would catch it.
- A `:has()` match while the strip is not pinned. That only costs an extra scroll.
- A real Windows browser, real zoom and WebKit. Those are C215 in `.agents/windows-verification.md`.
- If the strip is later pinned only while there are unsaved changes, the `:has()` rule has to follow it.
