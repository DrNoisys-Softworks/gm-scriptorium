# Counts that go stale

These figures change as the repository changes, so they live here and not in the human documents.
Update the line in the same change that moves the number. Last measured on the commit that
introduced this file.

| Item | Value | How to measure |
|---|---|---|
| Tests (`npm test`) | 6479 total, 6479 pass, 0 skipped (fully unskipped run) | The `tests` and `skipped` lines at the end of `npm test` output. A fully unskipped run needs `PLAYWRIGHT_MODULE` (absolute path to the playwright package folder) and axe-core installed beside it, or `AXE_CORE_PATH` (full path to the `axe.min.js` file) when it is not; see `../docs/DEVELOPING.md#running-the-browser-tests`; without them the real-browser tests skip and the count reads as skipped. |
| Assets embedded by `npm run package` | 132 | `node -e "console.log(require('./scripts/pkg-assets.js').expectedAssets().length)"` |
