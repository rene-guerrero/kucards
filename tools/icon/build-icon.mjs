// KuCards app icon from the game's real card art (cardBackSvg / cardSvg output) → SVGs + Android PNGs
// usage: node tools/icon/build-icon.mjs <dir with back.svg + face.svg from cardBackSvg("ku",60) / cardSvg(mar 7,{width:60})> <repo root>
// needs @resvg/resvg-js (kept outside the app deps: npm i @resvg/resvg-js in a tools folder)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
const [probe, repo] = process.argv.slice(2);
const inner = (f) => readFileSync(`${probe}/${f}`, 'utf8').trim().replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
const back = inner('back.svg'), face = inner('face.svg');
const card = (body, x, y, rot, s) =>
  `<g transform="translate(${x} ${y}) rotate(${rot}) translate(${-30 * s} ${-45 * s})"><svg width="${60 * s}" height="${90 * s}" viewBox="0 0 60 90">${body}</svg></g>`;
// the two cards, centred on (cx, cy) at scale s
const fan = (cx, cy, s) =>
  `<g filter="url(#sh)">${card(face, cx - 13 * s, cy + 1 * s, -13, s)}${card(back, cx + 13 * s, cy - 1 * s, 10, s)}</g>`;
const defs = `<defs><radialGradient id="felt" cx="50%" cy="42%" r="70%"><stop offset="0" stop-color="#1c6a6c"/><stop offset=".55" stop-color="#0f3a44"/><stop offset="1" stop-color="#0a2029"/></radialGradient>
<filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000" flood-opacity=".45"/></filter></defs>`;
const svg = (w, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" width="${w}" height="${w}">${defs}${body}</svg>`;
// web: rounded tile; maskable: full bleed, cards in the 80% safe circle; Android foreground: transparent, 66/108 safe zone
const icon = svg(512, `<rect width="512" height="512" rx="112" fill="url(#felt)"/>${fan(256, 262, 3.3)}`);
const maskable = svg(512, `<rect width="512" height="512" fill="url(#felt)"/>${fan(256, 262, 2.75)}`);
const fg = svg(432, `${fan(216, 220, 2.2)}`);
const legacy = (round) => svg(512, round ? `<circle cx="256" cy="256" r="256" fill="url(#felt)"/>${fan(256, 262, 2.9)}` : `<rect width="512" height="512" rx="96" fill="url(#felt)"/>${fan(256, 262, 3.1)}`);
writeFileSync(`${repo}/public/icon.svg`, icon);
writeFileSync(`${repo}/public/icon-maskable.svg`, maskable);
const png = (s, size) => new Resvg(s, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render().asPng();
writeFileSync(`${probe}/preview-icon.png`, png(icon, 256));
const D = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(D)) {
  const dir = `${repo}/android/app/src/main/res/mipmap-${d}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/ic_launcher_foreground.png`, png(fg, Math.round(108 * k)));
  writeFileSync(`${dir}/ic_launcher.png`, png(legacy(false), Math.round(48 * k)));
  writeFileSync(`${dir}/ic_launcher_round.png`, png(legacy(true), Math.round(48 * k)));
}
console.log('icons written');
