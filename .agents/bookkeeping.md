# Counts that go stale

These figures change as the repository changes, so they live here and not in the human documents.
Update the line in the same change that moves the number. Last measured on the commit that
introduced this file.

| Item | Value | How to measure |
|---|---|---|
| Tests (`npm test`) | 4998 total, 4998 pass, 0 skipped (fully unskipped run) | The `tests` and `skipped` lines at the end of `npm test` output. A fully unskipped run needs `PLAYWRIGHT_MODULE` (path to the playwright package) and axe-core found beside it or named by `AXE_CORE_PATH`; without them the real-browser tests skip and the count reads as skipped. |
| Assets embedded by `npm run package` | 130 | `node -e "console.log(require('./scripts/pkg-assets.js').expectedAssets().length)"` |
