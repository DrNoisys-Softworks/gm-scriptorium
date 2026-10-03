'use strict';

/*
 * V1.5a (docs/decisions/0029-remote-access.md section 6; SD-doc section 12): the sign-in page's
 * script. The admin CSP has form-action 'none', so the form is never submitted: every submit is
 * preventDefault()ed and the password goes through ScriptoriumAdmin.api (app.js's single fetch),
 * as JSON, to POST /auth/password. On 200 the page is replaced by the panel; on anything else the
 * server's own one generic message is shown with textContent. The password is never stored, logged
 * or put in a URL.
 */
(function () {
  var A = window.ScriptoriumAdmin;
  var GENERIC = 'Sign-in failed. Check the password and try again.';

  function init() {
    var form = document.querySelector('[data-role="signin-form"]');
    if (!form) return;
    var input = form.querySelector('#signin-password');
    var status = form.querySelector('[data-role="signin-status"]');
    var submit = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      A.setText(status, '');
      var password = input.value;
      if (password.length === 0) {
        A.setText(status, GENERIC);
        input.focus();
        return;
      }
      submit.disabled = true;
      A.api('/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password }),
      }).then(function (res) {
        if (res.ok) {
          input.value = '';
          location.replace('/');
          return;
        }
        submit.disabled = false;
        input.value = '';
        input.focus();
        A.setText(status, res.body && typeof res.body.message === 'string' ? res.body.message : GENERIC);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
