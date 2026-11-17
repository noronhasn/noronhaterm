'use strict';
// Gera o texto da página de downloads (Release) a partir de src/changelog.json, para a versão do package.json.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const ver = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const log = JSON.parse(fs.readFileSync(path.join(root, 'src', 'changelog.json'), 'utf8'));
const e = log.find((x) => x.version === ver);
const out = [`## NetDeck ${ver}`, ''];
if (e) { e.itens.forEach((i) => out.push('- ' + i)); } else out.push('Melhorias e correções.');
out.push('', '**Windows:** baixe `NetDeck Setup ...exe`. **Linux:** `.deb` ou `.AppImage`. **Android:** `.apk`.');
process.stdout.write(out.join('\n') + '\n');
