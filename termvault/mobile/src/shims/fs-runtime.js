'use strict';
// "fs" no app: o localStorage do WebView (área privada do aplicativo).
const { createFsShim } = require('./fs');
module.exports = createFsShim(globalThis.localStorage);
