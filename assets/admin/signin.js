'use strict';

/*
 * V1.5a (docs/decisions/0029-remote-access.md section 6) and ADR 0054 (sections 3, 5 and 7): the
 * sign-in page's script. The admin CSP has form-action 'none', so the form is never submitted: every
 * submit is preventDefault()ed and the username and password go through ScriptoriumAdmin.api (app.js's
 * single fetch), as JSON, to POST /auth/password. On 200 the page is replaced by the panel; on anything
 * else the server's own one generic message is shown with textContent, the password is cleared and the
 * username is kept. The credentials are never stored, logged or put in a URL.
 *
 * Password managers: neither field is cleared before navigating away on success. Browsers capture the
 * credential from the filled form when the page navigates (Firefox), or at the submit event (Chromium
 * and Edge), so clearing the fields first would defeat that. Whether each browser really offers to save
 * is a manual check, recorded in the Windows runbook and the owner acceptance table.
 *
 * The campaign hint: a published site's GM link opens "/?campaign=<name>". It is re-checked here (the
 * whole query must be that one parameter, with the shape of a campaign name) and forwarded after sign-in
 * as the same query; anything else is dropped.
 * The server never reads it as anything but a shape (src/admin/router.js isRootRequest).
 */
(function () {
  var A = window.ScriptoriumAdmin;
  var GENERIC = "That didn't work. Check your username and password.";
  // The whole query must be exactly one campaign=<name> parameter, the same rule the server applies to
  // decide whether "/" is the sign-in page at all (src/admin/router.js isRootRequest), and the name must
  // have the shape of a campaign name (src/setup/validate.js NAME_RE). Whether it names a registered
  // campaign is only decided after sign-in.
  var HINT_QUERY_RE = /^\?campaign=([a-z0-9][a-z0-9-]{0,62})$/;

  function target() {
    var match = HINT_QUERY_RE.exec(location.search);
    return match ? '/?campaign=' + match[1] : '/';
  }

  function init() {
    var form = document.querySelector('[data-role="signin-form"]');
    if (!form) return;
    var username = form.querySelector('#signin-username');
    var input = form.querySelector('#signin-password');
    var status = form.querySelector('[data-role="signin-status"]');
    var icon = form.querySelector('[data-role="signin-icon"]');
    var message = form.querySelector('[data-role="signin-message"]');
    var submit = form.querySelector('button[type="submit"]');

    function show(text) {
      A.setText(message, text);
      // an SVG element has no .hidden property, so the attribute is set directly
      if (text === '') icon.setAttribute('hidden', '');
      else icon.removeAttribute('hidden');
      [username, input].forEach(function (field) {
        if (text === '') {
          field.removeAttribute('aria-invalid');
          field.removeAttribute('aria-describedby');
        } else {
          field.setAttribute('aria-invalid', 'true');
          field.setAttribute('aria-describedby', status.id);
        }
      });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      show('');
      var name = username.value.trim();
      var password = input.value;
      if (name.length === 0 || password.length === 0) {
        show(GENERIC);
        (name.length === 0 ? username : input).focus();
        return;
      }
      submit.disabled = true;
      A.api('/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password: password }),
      }).then(function (res) {
        if (res.ok) {
          // Deliberately NOT clearing either field first (see the note at the top).
          location.replace(target());
          return;
        }
        submit.disabled = false;
        input.value = '';
        input.focus();
        show(res.body && typeof res.body.message === 'string' ? res.body.message : GENERIC);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
