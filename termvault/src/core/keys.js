'use strict';
// Geração/importação de chaves SSH e cálculo de chave pública e fingerprint.
const crypto = require('crypto');

const str = (buf) => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const l = Buffer.alloc(4);
  l.writeUInt32BE(b.length);
  return Buffer.concat([l, b]);
};
const mpint = (buf) => {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let b = buf.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return str(b);
};
const b64u = (s) => Buffer.from(s, 'base64url');
const CURVES = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' };

function blobFromKeyObject(keyObj) {
  const jwk = keyObj.export({ format: 'jwk' });
  if (jwk.kty === 'RSA') {
    return { type: 'ssh-rsa', blob: Buffer.concat([str('ssh-rsa'), mpint(b64u(jwk.e)), mpint(b64u(jwk.n))]) };
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    return { type: 'ssh-ed25519', blob: Buffer.concat([str('ssh-ed25519'), str(b64u(jwk.x))]) };
  }
  if (jwk.kty === 'EC' && CURVES[jwk.crv]) {
    const c = CURVES[jwk.crv];
    const t = 'ecdsa-sha2-' + c;
    const pt = Buffer.concat([Buffer.from([4]), b64u(jwk.x), b64u(jwk.y)]);
    return { type: t, blob: Buffer.concat([str(t), str(c), str(pt)]) };
  }
  throw new Error('Tipo de chave não suportado');
}

function fingerprint(blob) {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

const cleanComment = (c) => String(c || '').replace(/[^A-Za-z0-9@._+-]/g, '');

function publicLine(type, blob, comment) {
  const c = cleanComment(comment);
  return `${type} ${blob.toString('base64')}${c ? ' ' + c : ''}`;
}

// A chave pública fica em claro no formato openssh-key-v1, mesmo se a privada for cifrada.
function parseOpenSshPrivate(text) {
  const m = text.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/);
  if (!m) return null;
  const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  const magic = 'openssh-key-v1\0';
  if (buf.subarray(0, magic.length).toString('latin1') !== magic) throw new Error('Chave OpenSSH inválida');
  let off = magic.length;
  const readStr = () => { const l = buf.readUInt32BE(off); off += 4; const s = buf.subarray(off, off + l); off += l; return s; };
  const cipher = readStr().toString();
  readStr(); readStr(); // kdfname, kdfoptions
  const n = buf.readUInt32BE(off); off += 4;
  if (n !== 1) throw new Error('Arquivo com múltiplas chaves não é suportado');
  const blob = Buffer.from(readStr());
  const type = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString();
  return { type, blob, encrypted: cipher !== 'none' };
}

// PuTTY .ppk: a chave pública também fica em claro (Public-Lines), mesmo com a privada cifrada.
function parsePpk(text) {
  const m = text.match(/^PuTTY-User-Key-File-\d+:\s*(\S+)\s*$/m);
  if (!m) return null;
  const pl = text.match(/^Public-Lines:\s*(\d+)\s*$/m);
  if (!pl) throw new Error('Arquivo .ppk inválido');
  const rows = text.slice(pl.index + pl[0].length).split(/\r?\n/).filter(Boolean).slice(0, Number(pl[1]));
  const blob = Buffer.from(rows.join(''), 'base64');
  const enc = text.match(/^Encryption:\s*(\S+)/m);
  return { type: m[1], blob, encrypted: !!enc && enc[1] !== 'none' };
}

function wrapPem(label, buf) {
  const lines = buf.toString('base64').match(/.{1,70}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

function serializeEd25519OpenSsh(seed, pub, comment) {
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([
    check, check,
    str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str(comment || ''),
  ]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const pubBlob = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  const n1 = Buffer.alloc(4); n1.writeUInt32BE(1);
  return wrapPem('OPENSSH PRIVATE KEY', Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'), str('none'), str('none'), str(''), n1, str(pubBlob), str(priv),
  ]));
}

// Descreve uma chave privada existente (para importação): tipo, blob público, fingerprint.
function describePrivateKey(pem, passphrase) {
  const o = parseOpenSshPrivate(pem);
  if (o) return { type: o.type, blob: o.blob, encrypted: o.encrypted };
  const ppk = parsePpk(pem);
  if (ppk) return ppk;
  try {
    const ko = crypto.createPrivateKey({ key: pem, passphrase: passphrase || undefined });
    const { type, blob } = blobFromKeyObject(crypto.createPublicKey(ko));
    return { type, blob, encrypted: false };
  } catch (e) {
    if (/passphrase|bad decrypt|encrypted/i.test(e.message)) throw new Error('Chave protegida: informe a passphrase');
    throw new Error('Formato de chave não reconhecido (use OpenSSH ou PEM)');
  }
}

function generateKey({ type = 'ed25519', bits = 4096, comment = '' } = {}) {
  let privateKey, pubType, blob;
  if (type === 'ed25519') {
    const { privateKey: pk } = crypto.generateKeyPairSync('ed25519');
    const jwk = pk.export({ format: 'jwk' });
    const seed = b64u(jwk.d), pub = b64u(jwk.x);
    privateKey = serializeEd25519OpenSsh(seed, pub, comment);
    ({ type: pubType, blob } = blobFromKeyObject(crypto.createPublicKey(pk)));
  } else if (type === 'rsa') {
    if (bits < 2048) throw new Error('RSA com menos de 2048 bits é considerada insegura');
    const { privateKey: pk } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
    privateKey = pk.export({ type: 'pkcs1', format: 'pem' });
    ({ type: pubType, blob } = blobFromKeyObject(crypto.createPublicKey(pk)));
  } else if (type === 'ecdsa' || type === 'ecdsa384' || type === 'ecdsa521') {
    const namedCurve = { ecdsa: 'prime256v1', ecdsa384: 'secp384r1', ecdsa521: 'secp521r1' }[type];
    const { privateKey: pk } = crypto.generateKeyPairSync('ec', { namedCurve });
    privateKey = pk.export({ type: 'sec1', format: 'pem' });
    ({ type: pubType, blob } = blobFromKeyObject(crypto.createPublicKey(pk)));
  } else {
    throw new Error('Tipo de chave desconhecido: ' + type);
  }
  return { type: pubType, privateKey, publicKey: publicLine(pubType, blob, comment), fingerprint: fingerprint(blob) };
}

module.exports = {
  generateKey, describePrivateKey, parseOpenSshPrivate, parsePpk, fingerprint, publicLine, cleanComment,
};
