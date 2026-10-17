# 0069. The real-browser tests run on every pull request, and the check must pass

## Summary

Seventeen test files drive a real browser, and until now they skipped themselves on the machines that ran every pull request, so the admin panel's screens were not checked before merge. A new `browser` check in CI installs Playwright and axe-core outside the repository and runs those files in Chromium and Firefox, on every pull request and every push to `main`. A small runner script reads the test output and fails on any failed, cancelled, skipped or todo test, on zero tests and on a missing summary, because `node --test` treats a skip as success. The main alternative, running them only after a merge, is rejected below because it finds a broken screen when the change is already in `main`. The limit a reader will meet is that one known flake, the new-vault setup test in issue 137, may be re-run once, and the packaged executable and Windows browsers are still not covered.

Status: accepted. Builds on [ADR 0059](0059-hosted-sample-site.md), section 2 (the workflow rails), and on the artefact rule in `docs/DEVELOPING.md`.

## 1. What runs

A job named `browser` is the last job in `.github/workflows/ci.yml`. It checks out the code, runs `npm ci`, installs Playwright and axe-core into a folder outside the repository, installs Chromium and Firefox with their system libraries, and runs `node scripts/browser-tests.js run` with `PLAYWRIGHT_MODULE` pointing at the installed Playwright. The test files find axe-core beside that folder, as they do on a contributor's machine.

The runner starts `node --test` over a fixed list of files and reads its TAP summary. It exits 1 unless the summary shows tests that ran, with no failed, cancelled, skipped or todo test, and the child process itself ended cleanly. A timeout, a signal or a full output buffer counts as failure even when a clean-looking summary was printed first. The runner reads no environment variable itself, so a missing `PLAYWRIGHT_MODULE` reaches the tests, they skip, and the skips fail the run. Adding an early "is it set?" check would hide exactly that case.

Some of these files also hold tests that need no browser. They run twice, once in the `test` job and once here. That is accepted.

## 2. Where the versions live

The Playwright and axe-core versions are written once, as constants in `scripts/browser-tests.js`. CI installs from `node scripts/browser-tests.js packages`, so `ci.yml` carries no version. `docs/DEVELOPING.md` holds the same versions in its copy-and-paste commands, and `test/browser-tests.test.js` fails if those commands differ from the constants, or if any other tracked text carries a version token. This ADR names no version for the same reason.

The file list in the script is frozen. A structural test compares it with the set of test files that read `PLAYWRIGHT_MODULE`, so a new browser test that is not listed fails the build, and a listed file that stops needing a browser does too.

## 3. The guard, and why it is scoped

The only condition on the job is the public-repository guard the `test` job already has. There is no event condition and no path filter, so the job is never skipped in the public repository. The job has a 30 minute limit and cancels an older run of the same ref, the same shape as the packaged-smoke job.

The skip guard lives in the runner, which only the `browser` job calls. The `test` job is unchanged. On a plain Linux runner it legitimately skips a handful of tests (the Windows cross-compile, the installer and the packaging base), so a skip guard there would fail every pull request.

`test/ci-workflow.test.js` pins the job on the text of the workflow file: the job names and their order, the guard line, the time limit, the concurrency, the two shared action pins, the four run lines, no `continue-on-error`, `|| true` or `always()`, and no version token. Each pin is shown to fail on a loosened copy.

## 4. Decision 1: when the check runs

Chosen: **every pull request and every push to `main`.**

Rejected:

- **(b) Every pull request except docs-only ones, plus `main`.** A path rule for "docs-only" is one more thing to get wrong, and the saving is small.
- **(c) Only pull requests that touch `assets/admin/` or the browser test files.** Too narrow: a server-side change can break these tests too, and a filtered job would be skipped on exactly that change.
- **(d) External contributors only.** Maintainers' own changes would go unchecked, and they change the admin panel most.
- **(e) `main` or a schedule only.** The failure is found after the merge, and a change that breaks a screen can still go green on its pull request.

The `test` job gets no skip warning for the same reason: the `browser` job runs on every pull request, so a skipped browser test there is already covered.

## 5. Decision 2: whether the check is required

Chosen: **`browser` becomes a required check from its first green run on `main`.** The owner sets that in the repository ruleset after the merge. Nobody else in the project changes rulesets.

Rejected:

- **(b) Advisory until issue 137 is root-caused, then required.** A check that can be ignored will be, and the failure it exists to catch could again reach `main` in the meantime.
- **(c) Required with no re-run allowance.** The known flake is narrow and named, and without a single re-run it would block unrelated pull requests until it is fixed.

## 6. The re-run rule, and when it ends

If the `browser` check fails, and the only failures are the new-vault setup test described in [issue 137](https://github.com/DrNoisys-Softworks/gm-scriptorium/issues/137) and its parent test, `start a new campaign, browsing in <browser>`, a maintainer may re-run the failed job once. One flake shows as two failures, because a failing subtest also fails its parent. Any other failure, or a failure on the re-run, is a real failure. The allowance is removed in the change that fixes that issue.

## 7. Cost

The repository is public, so the job uses standard hosted runners at no charge. The only figure measured so far is the whole unskipped suite on a local four-core machine, which took about five minutes. An estimate for the job on a hosted runner is 10 to 14 minutes in total, most of it the browser files plus dependency and browser installs. The first runs on `main` replace that estimate with a measurement.

## 8. Limits

Will catch:

- A failed assertion, a failed accessibility scan or a crash in any listed file, in Chromium or Firefox, before merge.
- A run in which the browsers are missing, because every skip fails the runner.
- A browser test file that is not on the list, or a version that has drifted from the one in the developer guide.
- A change to the job's conditions, pins, limits or run lines, through the pinning test.

Will not catch, deliberately:

- The packaged executable. These tests run against the source tree, and the artefact rule in `docs/DEVELOPING.md` still applies.
- Windows or macOS browsers. The job runs on Linux only.
- WebKit. Only Chromium and Firefox are installed.
- An older run on `main` that a newer push cancels. Cancelling saves time, and the newer run covers the newer code.
- That the runner's spawn path works. It has no unit test; the first real run, in CI or locally, is its only proof.
