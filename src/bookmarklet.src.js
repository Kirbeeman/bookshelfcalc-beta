// The phone sync bookmark. Tapped on amazon.com, it reads what the sync script reads (Content & Devices list,
// prices paid from order pages, each book's genre, pages and price), entirely inside the user's own Amazon tab,
// then hands it to the calculator page it opens. Nothing goes anywhere else.
// build.py inserts the shared functions from template.user.js at CORE and minifies it; the page fills in SITE.
(async () => {
  // Loaded by the short bookmark as <site>/bm.js, so the site's address comes from where this file was loaded
  const SITE = new URL('./', (document.currentScript && document.currentScript.src) || '__SITE__').href;
  // The signed bookmark loads this file with its signed fingerprint (integrity). The older bookmark doesn't check anything.
  const checked = !!(document.currentScript && document.currentScript.integrity);
  const host = location.hostname;
  if (!/^www\.amazon\.(com|co\.uk|ca|com\.au)$/.test(host)) {
    const to = /^(?:[a-z.]+\.)?amazon\.(com|co\.uk|ca|com\.au)$/.test(host) ? 'https://www.' + host.replace(/^.*?amazon\./, 'amazon.') + '/' : 'https://www.amazon.com/';
    if (confirm('Open amazon.com first, then tap the Shelf of Shame sync bookmark again there.\n\nGo to amazon.com now?')) location.href = to;
    return;
  }
  if (window.__klcbm) { window.__klcbm.show(); return; }
  const LS = 'klcbm-';
  const GM_getValue = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : v; } catch { return d; } };
  const GM_setValue = (k, v) => { try { localStorage.setItem(LS + k, v); } catch {} };
  let stop = false;
  // "Send what I have" makes every remaining step return at once
  const setTimeout = (f, ms) => window.setTimeout(f, stop ? 0 : ms);
  const gmGet = url => stop ? Promise.reject(new Error('stopped')) : fetch(url, {credentials: 'include'}).then(async r => ({status: r.status, text: await r.text(), finalUrl: r.url}));
  const gmPost = (url, body) => fetch(url, {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body}).then(async r => ({status: r.status, text: await r.text()}));
  GM_setValue('kindleHost', host);

  /*CORE*/

  // ---------- the panel ----------
  const box = document.createElement('div');
  box.id = 'klcbm';
  box.innerHTML = `<style>#klcbm{position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;max-width:440px;margin:0 auto;background:#1b1e20;color:#f2f2ee;font:15px/1.45 system-ui,sans-serif;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);padding:14px 16px}
#klcbm b{font-weight:700}#klcbm .t{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}#klcbm .x{all:unset;cursor:pointer;font-size:22px;line-height:1;opacity:.7;padding:0 4px}
#klcbm .m{font-size:14px;color:#cfd3cf;min-height:20px}#klcbm .bar{height:6px;border-radius:3px;background:#3a3f43;margin:10px 0;overflow:hidden}#klcbm .bar i{display:block;height:100%;width:0;background:#9fb0ff;transition:width .3s}
#klcbm .row{display:flex;gap:8px;flex-wrap:wrap}#klcbm button.b{all:unset;cursor:pointer;text-align:center;flex:1;padding:11px 12px;border-radius:8px;font-weight:700;font-size:15px;background:#3a3f43;color:#f2f2ee}#klcbm button.b.p{background:#f2c14e;color:#1b1206}#klcbm button.b[disabled]{opacity:.4;cursor:default}
#klcbm a{color:#9fb0ff}#klcbm [hidden]{display:none!important}</style>
<div class="t"><b>Shelf of Shame sync</b><button class="x" aria-label="Close">×</button></div>
<div class="m" id="klcbm-m">Starting…</div><div class="bar"><i id="klcbm-bar"></i></div>
<div class="row"><button class="b" id="klcbm-stop" hidden>Send what I have</button><button class="b p" id="klcbm-send" hidden>Send to Shelf of Shame</button></div>
<div class="m" id="klcbm-old" hidden style="margin-top:10px;font-size:13px">This is the older Shelf sync bookmark, which doesn't check that its code is genuine. Please set it up again once: on the Shelf of Shame, open <b>Settings</b> and tap <b>Set up the bookmark</b>.</div>`;
  document.body.appendChild(box);
  const $ = id => document.getElementById(id);
  if (!checked) $('klcbm-old').hidden = false;
  const msg = (h, frac) => { $('klcbm-m').innerHTML = h; if (frac != null) $('klcbm-bar').style.width = Math.round(Math.min(1, frac) * 100) + '%'; };
  window.__klcbm = {show: () => { box.hidden = false; }};
  box.querySelector('.x').onclick = () => { stop = true; box.remove(); delete window.__klcbm; };
  $('klcbm-stop').onclick = () => { stop = true; $('klcbm-stop').disabled = true; msg('Finishing up…'); };

  const payload = {v: 1, host, time: Date.now(), owned: null, prices: {}, info: {}, errors: {}};
  // 1. Your books and purchase dates (Content & Devices)
  try {
    msg('Reading your books from Content &amp; Devices…', 0.05);
    const items = await fetchOwnership(m => msg(m.replace(/^Reading purchase dates…/, 'Reading your books…'), 0.1));
    payload.owned = {v: 3, time: Date.now(), items};
  } catch (e) {
    const cd = `https://${host}/hz/mycd/digital-console/contentlist/booksAll/dateDsc/`;
    msg(/sign in/i.test(e.message || '') ? `<b>Amazon wants you to sign in for Content &amp; Devices.</b> Open <a href="${cd}">Content &amp; Devices</a>, sign in if it asks, then tap the bookmark again.` : `Couldn't read your books: ${String(e.message || e).replace(/</g, '&lt;')}. Try again in a minute.`, 0);
    $('klcbm-stop').hidden = true;
    return;
  }
  const items = payload.owned.items;
  $('klcbm-stop').hidden = false;
  // 2. Prices paid (up to 150 orders each time; each order is read once and remembered)
  if (!stop) {
    try { payload.prices = await fetchPrices(items, m => { const n = m.match(/(\d+) of (\d+)/); msg(m, n ? 0.1 + 0.4 * n[1] / n[2] : 0.15); }); payload.pPaused = pricesPaused; }
    catch (e) { payload.errors.prices = String(e.message || e); }
  } else payload.prices = JSON.parse(GM_getValue('prices', '{}') || '{}');
  // 3. Genre, pages and today's price, up to 80 new books each time (kept here, so later taps carry on where this one stopped)
  const info = JSON.parse(GM_getValue('info', '{}') || '{}');
  const todo = items.map(i => i.asin).filter(a => a && !(a in info)).slice(0, 80);
  for (let i = 0; i < todo.length && !stop; i++) {
    msg(`Reading genres and pages… ${i} of ${todo.length}`, 0.5 + 0.45 * i / todo.length);
    try {
      const r = await gmGet(`https://${host}/dp/${encodeURIComponent(todo[i])}`);
      if (/validateCaptcha|Enter the characters you see/i.test(r.text)) { payload.errors.info = 'paused'; break; }
      if (r.status === 200) info[todo[i]] = parseBookInfo(r.text);
    } catch {}
    if (i % 10 === 9) GM_setValue('info', JSON.stringify(info));
    await new Promise(res => setTimeout(res, 600));
  }
  GM_setValue('info', JSON.stringify(info));
  const mine = new Set(items.map(i => i.asin));
  for (const a in info) if (mine.has(a)) payload.info[a] = info[a];
  const left = items.filter(i => i.asin && !(i.asin in info)).length;

  // ---------- hand it to the calculator ----------
  const siteOrigin = new URL(SITE).origin;
  msg(`<b>Ready:</b> ${items.length} books${left ? `. ${left} still need genres and pages; tap the bookmark again later to carry on.` : '.'}`, 1);
  $('klcbm-stop').hidden = true;
  const send = $('klcbm-send'); send.hidden = false;
  let sent = false;
  window.addEventListener('message', e => {
    if (e.origin !== siteOrigin || !e.data || e.data.klc !== 1) return;
    if (e.data.type === 'bm-ready' && !sent) { sent = true; e.source.postMessage({klc: 1, type: 'bm-data', data: JSON.stringify(payload)}, siteOrigin); }
    if (e.data.type === 'bm-done') msg(`<b>Sent.</b> Your library is on the Shelf of Shame tab.${left ? ` Tap the bookmark again later for the other ${left} books' genres and pages.` : ''} You can close this.`, 1);
  });
  send.onclick = () => {
    sent = false;
    const w = window.open(SITE + '#bm', '_blank');
    if (!w) { msg('Your browser blocked the new tab. Allow pop-ups for amazon.com, then tap Send again.'); return; }
    msg('Sending…');
    window.setTimeout(() => { if (!sent) msg('The Shelf of Shame page didn\'t answer. Tap Send to try again.'); }, 30000);
  };
})();
