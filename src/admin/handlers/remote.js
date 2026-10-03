'use strict';
// C2 stub: every handler answers 501 until C7 implements it.
function notImplemented(req, res) {
  res.writeHead(501);
  res.end('not implemented');
}
module.exports = {
  passwordSignin: notImplemented,
  openPreview: notImplemented,
  apiRemote: notImplemented,
  signout: notImplemented,
  signoutAll: notImplemented,
  previewEnter: notImplemented,
};
