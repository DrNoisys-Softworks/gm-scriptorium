'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertNotInsideAnyVault } = require('../remote/paths');
const { writePrivateFileAtomic } = require('../remote/privatefile');

/*
 * ADR 0028, section 7. The launcher file is how the one-time code reaches the browser without
 * touching a command line or a URL. It is a small HTML file in the per-user panel folder (owner-only,
 * never the system temp folder, never inside a vault) that the operating system opens as a file: page.
 * That page POSTs the code once to the loopback panel, from a page with no origin of its own:
 *
 *  - its own meta CSP lets exactly one fixed inline script run and the form post to this port and
 *    nowhere else, and the panel's CSP never applies to it (it is not a panel response);
 *  - the POST carries "Origin: null", which the gate accepts for this one path only;
 *  - the panel answers 200, not a redirect, with the session cookie and an interstitial whose script
 *    then navigates to / from a same-origin page, so the SameSite=Strict cookie is sent.
 */

// The script is fixed text, so its hash is a constant of this file, not of the code or port.
const LAUNCH_SCRIPT = "document.getElementById('f').submit();";
const SCRIPT_HASH = crypto.createHash('sha256').update(LAUNCH_SCRIPT, 'utf8').digest('base64');

/** @param {string} panelDir @param {number} pid */
function launcherPath(panelDir, pid) {
  return path.join(panelDir, `launch-${pid}.html`);
}

/**
 * @param {{ port: number, code: string }} info
 * @returns {string} the fixed HTML with the port and the code filled in
 */
function renderLauncher({ port, code }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('renderLauncher: the port is not usable');
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(code)) throw new Error('renderLauncher: the code is not usable');
  const origin = `http://127.0.0.1:${port}`;
  const csp = `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; form-action ${origin}; base-uri 'none'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>Signing in to GM-Scriptorium</title>
</head>
<body>
<form id="f" method="post" action="${origin}/auth/launch">
<input type="hidden" name="code" value="${code}">
<noscript><p>Continue to GM-Scriptorium.</p><button type="submit">Continue</button></noscript>
</form>
<script>${LAUNCH_SCRIPT}</script>
</body>
</html>
`;
}

/**
 * Writes the launcher (atomically, 0600, in the 0700 panel folder) after checking that the folder is
 * not inside any registered campaign's vault.
 *
 * @param {{ panelDir: string, config: object, pid: number, port: number, code: string }} info
 * @returns {string} the file written
 */
function writeLauncher({ panelDir, config, pid, port, code }) {
  assertNotInsideAnyVault(panelDir, config);
  const file = launcherPath(panelDir, pid);
  writePrivateFileAtomic(file, renderLauncher({ port, code }));
  return file;
}

/** Best effort, swallowed: a leftover file is harmless once its code is spent or expired. */
function removeLauncher(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone, or held open on Windows; nothing useful to do
  }
}

module.exports = { LAUNCH_SCRIPT, SCRIPT_HASH, launcherPath, renderLauncher, writeLauncher, removeLauncher };
