'use strict';

/*
 * Windows Notepad and PowerShell's `Set-Content -Encoding utf8` put a UTF-8 byte-order mark at the
 * start of a file. `fs.readFileSync(path, 'utf8')` keeps it as U+FEFF, and JSON.parse and the TOML
 * parser both reject it (issue #48). Config readers run their text through this before parsing.
 * Writers never add one.
 */

/**
 * @param {string} text
 * @returns {string} `text` without one leading U+FEFF; a U+FEFF anywhere else is content and stays
 */
function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

module.exports = { stripBom };
