'use strict';
// Chaves SSH (gerar/importar) não existem no Android: o app usa só usuário e senha.
const no = () => { throw new Error('Chaves SSH não estão disponíveis no Android'); };
module.exports = { generateKey: no, describePrivateKey: no, publicLine: no, fingerprint: no };
