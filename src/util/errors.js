'use strict';

/*
 * Error names the thing: campaign, path, and what specifically was wrong
 * (Engineering Brief section 9, non-functional). These error classes carry
 * that structure so a catch site does not have to reconstruct it from a
 * bare Error's message string.
 */

class ScriptoriumError extends Error {
  constructor(message, { path: atPath = null, campaign = null, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.path = atPath;
    this.campaign = campaign;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Thrown by src/vault/read.js when a filesystem-level read fails while
 * walking or reading the vault (ENOENT after existence was already
 * established, EIO from a dropped soft-mounted share, EACCES, and so on).
 *
 * This is deliberately distinct from a gray-matter frontmatter *parse*
 * failure, which is a content defect the generator itself would skip past
 * silently and which `check` reports as an ordinary per-file finding while
 * continuing the walk. A VaultReadError means the filesystem stopped
 * answering mid-walk and the whole run must abort: a `check` that returns
 * successfully after silently dropping the unreadable half of the vault is
 * more dangerous than one that fails, because --json output is consumed by
 * Claude and determinism is a hard requirement (Decisions Addendum, gap 2).
 */
class VaultReadError extends ScriptoriumError {
  constructor(atPath, cause, { campaign = null } = {}) {
    const causeCode = cause && cause.code ? ` (${cause.code})` : '';
    super(`could not read vault path: ${atPath}${causeCode}`, {
      path: atPath,
      campaign,
      cause,
    });
  }
}

/**
 * Thrown by src/config/load.js for a config error there is no reasonable
 * way to proceed past: an unrecognised key inside a `match` table (section
 * 5 of the Engineering Brief says this must be a hard error, never
 * ignored, so a future match key added by a newer Scriptorium cannot
 * silently match on an older one), a missing config_version, or a
 * config_version newer than this binary understands.
 */
class ConfigError extends ScriptoriumError {}

/**
 * Thrown by src/vault/locate.js: the exit-3 taxonomy. `reason` is one of
 * "not-found" (the configured path does not exist: unmounted share,
 * unmapped drive, typo) or "not-a-vault" (the path exists and is readable
 * but has no _meta/vault-config.md). The two get different messages
 * deliberately (section 2.1: "distinguishing path not found from found
 * but not a vault").
 */
class VaultUnreachableError extends ScriptoriumError {
  constructor(message, { path: atPath, campaign, reason }) {
    super(message, { path: atPath, campaign });
    this.reason = reason;
  }
}

/**
 * Thrown by src/update/*: gh absent, unauthenticated, or a 404 from the release
 * lookup that is indistinguishable from "no such release" without authentication.
 * Maps to exit code 4.
 */
class UpdatePrerequisiteError extends ScriptoriumError {}

/**
 * ADR 0034 / SD-2. Thrown internally by src/vault/read.js's readFrontmatter() and
 * parseFrontmatterText() for a refused (non-YAML) frontmatter fence, and never thrown OUT of
 * either function: both return `{ ok: false, error: new FrontmatterLanguageError(...) }`
 * instead, mirroring the ordinary gray-matter-parse-failure shape those functions already used.
 * Distinguishing this from a plain parse-failure Error lets src/checks/frontmatter.js's
 * runParseError() suppress it (a refused fence is reported once, as
 * frontmatter/non-yaml-language, never twice as frontmatter/parse-error too).
 *
 * `tag` holds only the RENDERED tag (src/vault/fence.js's renderTag(), already bounded and
 * escaped) -- never the raw, attacker-controlled fence text. `reason` is 'language' (a
 * registered-but-disallowed or unrecognised tag) or 'unterminated' (no newline within the
 * predicate's bounded head, so YAML-ness could not be confirmed; fails closed).
 */
class FrontmatterLanguageError extends ScriptoriumError {
  constructor(atPath, { tag, reason }) {
    super(
      `frontmatter declares the language "${tag}" after its opening ---; Scriptorium reads YAML frontmatter only and did not parse this file`,
      { path: atPath },
    );
    this.code = 'FRONTMATTER_NON_YAML_LANGUAGE';
    this.tag = tag;
    this.reason = reason;
  }
}

module.exports = {
  ScriptoriumError,
  VaultReadError,
  ConfigError,
  VaultUnreachableError,
  UpdatePrerequisiteError,
  FrontmatterLanguageError,
};
