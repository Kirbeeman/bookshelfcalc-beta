// Draws the site icons as PNGs (run: node make_icons.js, needs Playwright). Output goes next to this file's parent: ../
// tag = the book with its price tag (every theme), web = the book with a cobweb (Halloween theme).
const { chromium } = require('playwright');
const path = require('path');
const C = {paper:'#f7f8f5', ink:'#1b1e20', navy:'#34466e', navyDark:'#26334f', brown:'#7e4f33', brownDark:'#5f3a25', cream:'#f7f1e3', gold:'#f2c14e'};
const ART = {
  tag: `<rect x="12" y="10" width="30" height="44" rx="3" fill="${C.navy}"/><rect x="12" y="10" width="6" height="44" rx="2" fill="${C.navyDark}"/><rect x="38" y="13" width="4" height="38" fill="${C.cream}"/>
    <path d="M40 16 C48 16 50 24 49 30" stroke="${C.ink}" stroke-width="1.5" fill="none"/>
    <g transform="rotate(14 49 30)"><path d="M43 30 L55 30 L55 50 L43 50 L43 34 Z" fill="${C.gold}"/><circle cx="49" cy="34" r="1.6" fill="${C.paper}"/>
    <text x="49" y="46.5" text-anchor="middle" font-family="Georgia,serif" font-weight="700" font-size="11" fill="${C.ink}">$</text></g>`,
  // Halloween: a jack-o'-lantern book (orange cover with pumpkin ribs, a stem, and a carved face glowing from inside)
  web: `<path d="M33 13 Q33 6 38 3" stroke="#46741f" stroke-width="4" fill="none" stroke-linecap="round"/>
    <path d="M36 9 Q43 5 46 10 Q40 12 36 9 Z" fill="#9be35a"/>
    <rect x="10" y="12" width="44" height="46" rx="5" fill="#ff8c2e"/>
    <rect x="10" y="12" width="7" height="46" rx="3.5" fill="#c45f12"/><rect x="50" y="15" width="4" height="40" fill="#f3ecff"/>
    <path d="M26 13 Q22 35 26 57M39 13 Q43 35 39 57" stroke="#e0701a" stroke-width="2" fill="none"/>
    <path d="M18 30 L24 21 L30 30 Z M35 30 L41 21 L47 30 Z" fill="#ffd23f" stroke="#7a2e05" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M17 38 L23 41 L26 37 L30 42 L34 37 L38 42 L41 37 L44 41 L49 38 Q46 52 33 52 Q20 52 17 38 Z" fill="#ffd23f" stroke="#7a2e05" stroke-width="1.6" stroke-linejoin="round"/>`
  ,// Crawl: heart-print boxers
  boxers: `<path d="M10 17 Q32 13 54 17 L58 50 Q50 54 37 51 L33 36 Q32 34.5 31 36 L27 51 Q14 54 6 50 Z" fill="#fbeef4" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/><path transform="translate(13 23) scale(0.8)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(22 21.5) scale(0.75)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(31 24) scale(0.7)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(40 21.5) scale(0.75)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(48 23) scale(0.8)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(15 31) scale(0.8)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(25 30.5) scale(0.7)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(37 30.5) scale(0.7)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(46 31) scale(0.8)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(11 40) scale(0.75)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(19 40) scale(0.7)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(41 40) scale(0.7)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path transform="translate(49 40) scale(0.75)" d="M0 1.6C0-.8 3.2-1.6 4-.2 4.8-1.6 8-.8 8 1.6 8 4.6 4 7 4 7S0 4.6 0 1.6Z" fill="#e0283f"/><path d="M6 50 Q14 54 27 51 L26.5 53.5 Q14 57 5.5 53 Z" fill="#2b2d33" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/><path d="M58 50 Q50 54 37 51 L37.5 53.5 Q50 57 58.5 53 Z" fill="#2b2d33" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 12 Q32 8 54 12 L54 18 Q32 14 10 18 Z" fill="#2b2d33" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 13v4M22 12v4.4M28 11.6v4.6M34 11.6v4.6M40 12v4.4M46 12.6v4" stroke="#5a5d66" stroke-width="1"/><path d="M32 18v12" stroke="#c9a3b3" stroke-width="1.2"/>`
};
// rounded tile for tabs; full square for phone home screens (the phone rounds the corners itself)
const svg = (k, rx) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%"><rect width="64" height="64" rx="${rx}" fill="${k === 'web' ? '#16101e' : k === 'boxers' ? '#14161b' : C.paper}"/>${ART[k]}</svg>`;
const OUT = path.join(__dirname, '..');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const shot = async (html, w, h, file) => {
    await p.setViewportSize({width: w, height: h});
    await p.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
    await p.evaluate(() => document.fonts.ready).catch(() => {}); await p.waitForTimeout(300);
    await p.screenshot({path: path.join(OUT, file), omitBackground: true});
  };
  const only = process.argv.slice(2); // node make_icons.js boxers draws just that one
  for (const k of only.length ? only : ['tag', 'web', 'boxers']) {
    await shot(`<div style="width:64px;height:64px">${svg(k, 14)}</div>`, 64, 64, `icon-${k}.png`);
    await shot(`<div style="width:180px;height:180px">${svg(k, 0)}</div>`, 180, 180, `icon-${k}-180.png`);
  }
  if (only.length) { await b.close(); return; }
  // link preview card (1200x630) with the price-tag book
  await shot(`
    <div style="width:1200px;height:630px;background:#f7f8f5;display:flex;align-items:center;justify-content:center;gap:56px;font-family:Georgia,serif">
    <div style="width:340px;height:340px">${svg('tag', 60)}</div>
    <div><div style="font-weight:800;font-size:96px;line-height:1;color:#1b1e20">Shelf of<br>Shame</div>
    <div style="font-size:34px;color:#5d6560;margin-top:24px;max-width:600px">The Kindle books you bought and haven't read yet</div></div></div>`, 1200, 630, 'og.png');
  await b.close();
})();
