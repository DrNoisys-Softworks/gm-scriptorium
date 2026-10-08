'use strict';

/*
 * ADR 0028, section 7. The sign-in interstitial's whole job: the launcher page's POST has already
 * set the session cookie, but the browser will not send a SameSite=Strict cookie on a navigation
 * that started on another site. This page is same-origin, so navigating from here sends it.
 * replace() also drops this page from the history, so Back never returns to it.
 */
window.location.replace('/');
