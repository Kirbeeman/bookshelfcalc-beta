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
  web: `<rect x="13" y="9" width="36" height="47" rx="3" fill="${C.brown}"/><rect x="13" y="9" width="7" height="47" rx="2" fill="${C.brownDark}"/><rect x="45" y="12" width="4" height="41" fill="${C.cream}"/>
    <g stroke="${C.cream}" stroke-width="1.3" fill="none" stroke-linecap="round" opacity=".95">
    <path d="M49 9 L27 9 M49 9 L30 22 M49 9 L38 30 M49 9 L49 33"/>
    <path d="M43 9 Q42 12 44.5 14 Q46 16 49 15"/><path d="M36 9 Q35 14 39 17.5 Q42 22 49 21.5"/><path d="M30 9 Q29.5 16 34 21.5 Q38 28 49 28"/></g>
    <circle cx="39" cy="31" r="2" fill="${C.ink}"/><path d="M39 22 L39 29" stroke="${C.ink}" stroke-width=".8"/>`
};
// rounded tile for tabs; full square for phone home screens (the phone rounds the corners itself)
const svg = (k, rx) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%"><rect width="64" height="64" rx="${rx}" fill="${C.paper}"/>${ART[k]}</svg>`;
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
  for (const k of ['tag', 'web']) {
    await shot(`<div style="width:64px;height:64px">${svg(k, 14)}</div>`, 64, 64, `icon-${k}.png`);
    await shot(`<div style="width:180px;height:180px">${svg(k, 0)}</div>`, 180, 180, `icon-${k}-180.png`);
  }
  // link preview card (1200x630) with the price-tag book
  await shot(`
    <div style="width:1200px;height:630px;background:#f7f8f5;display:flex;align-items:center;justify-content:center;gap:56px;font-family:Georgia,serif">
    <div style="width:340px;height:340px">${svg('tag', 60)}</div>
    <div><div style="font-weight:800;font-size:96px;line-height:1;color:#1b1e20">Shelf of<br>Shame</div>
    <div style="font-size:34px;color:#5d6560;margin-top:24px;max-width:600px">The Kindle books you bought and haven't read yet</div></div></div>`, 1200, 630, 'og.png');
  await b.close();
})();
