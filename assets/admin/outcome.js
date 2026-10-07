'use strict';

/*
 * V1b SD-4: OC, a pure outcome-mapping namespace. Turns a {ok,status,body} api() result into the
 * slip/screen's {kind,role,message,detail,actions} (Engineering Brief's outcome table). Stub
 * only: test/admin-outcome.test.js drives the real implementation in the C3 commit.
 */
(function () {
  var BUSY_LABEL = { check: 'a check', build: 'a preview build', write: 'another save' };

  function unknownOutcome(status) {
    return { kind: 'unknown', role: 'alert', message: 'The save did not go through (HTTP ' + status + ').', detail: undefined, actions: ['reload'] };
  }

  /**
   * @param {{ok:boolean, status:number, body:any}} result an api() result
   * @param {'dry'|'save'} phase distinguishes a dry-run 200 ("ready") from a save 200 ("saved");
   *   every non-200 mapping is the same regardless of phase.
   */
  function mapOutcome(result, phase) {
    var status = result && result.status;
    var body = result && result.body;
    var ok = result && result.ok;

    if (status === 0) {
      return {
        kind: 'unreachable',
        role: 'alert',
        message: 'The panel could not be reached. Check that serve --admin is still running.',
        detail: undefined,
        actions: [],
      };
    }

    if (ok === true && status === 200 && body && body.ok === true) {
      if (phase === 'dry') {
        return { kind: 'ready', role: 'status', message: undefined, detail: undefined, actions: [] };
      }
      return { kind: 'saved', role: 'status', message: 'Saved', detail: undefined, actions: ['build-preview', 'overview'] };
    }

    var errorField = body && body.error;

    if (status === 409) {
      if (errorField === 'changed') {
        return {
          kind: 'changed',
          role: 'alert',
          message: body.message,
          detail: "Reloading discards this page's edits.",
          actions: ['keep-editing', 'reload'],
        };
      }
      if (errorField === 'busy') {
        var label = Object.prototype.hasOwnProperty.call(BUSY_LABEL, body.busy) ? BUSY_LABEL[body.busy] : 'another task';
        return {
          kind: 'busy',
          role: 'alert',
          message: 'The panel is busy running ' + label + '.',
          detail: undefined,
          actions: ['keep-editing'],
        };
      }
      if (errorField === 'exists') {
        return { kind: 'exists', role: 'alert', message: body.message, detail: undefined, actions: [] };
      }
      return unknownOutcome(status);
    }

    // V1e-9 (SD-103): placed before the generic 422 branch below.
    if (status === 422 && errorField === 'needs-ack') {
      return { kind: 'needs-ack', role: 'alert', message: body.message, detail: undefined, actions: ['keep-editing'] };
    }
    if (status === 422 && errorField === 'refused-by-check') {
      return { kind: 'refused-by-check', role: 'alert', message: body.message, detail: undefined, actions: ['keep-editing'] };
    }

    if (status === 422) {
      return {
        kind: 'invalid-on-disk',
        role: 'alert',
        message: body && body.message,
        detail: 'Fix the file outside the panel, then reload.',
        actions: ['reload'],
      };
    }

    if (status === 400 && body && typeof body.message === 'string') {
      return { kind: 'invalid', role: 'alert', message: body.message, detail: undefined, actions: [] };
    }

    if (status === 403 && body && body.error === 'read-only') {
      return { kind: 'read-only', role: 'alert', message: body.message, detail: undefined, actions: [] };
    }

    if (status === 403) {
      return {
        kind: 'refused',
        role: 'alert',
        message: 'The panel refused the request. Open the admin link printed in your terminal again.',
        detail: undefined,
        actions: [],
      };
    }

    if (status === 503) {
      return { kind: 'io', role: 'alert', message: body && body.message, detail: undefined, actions: [] };
    }

    if (status === 413) {
      return {
        kind: 'too-large',
        role: 'alert',
        message: 'The request was too large for the panel to accept.',
        detail: undefined,
        actions: [],
      };
    }

    return unknownOutcome(status);
  }

  var OC = { BUSY_LABEL: BUSY_LABEL, mapOutcome: mapOutcome };

  if (typeof module === 'object' && module.exports) {
    module.exports = { OC: OC };
    return;
  }

  window.ScriptoriumAdmin = window.ScriptoriumAdmin || {};
  window.ScriptoriumAdmin.OC = OC;
})();
