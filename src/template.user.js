// ==UserScript==
// @name         Shelf of Shame
// @namespace    kindle-library-calculator
// @version      2.0.0.0.3
// @updateURL    https://raw.githubusercontent.com/Kirbeeman/bookshelfcalc/main/kindle-library-calculator.user.js
// @downloadURL  https://raw.githubusercontent.com/Kirbeeman/bookshelfcalc/main/kindle-library-calculator.user.js
// @description  Library value, reading time and a Shelf of Shame for your Kindle books, kept in sync with your Goodreads shelves.
// @match        https://bookshelf.kirbee213.tv/*
// @match        https://kirbeeman.github.io/bookshelfcalc/*
// @match        https://www.goodreads.com/*
// @match        https://read.amazon.com/kindle-library*
// @match        https://read.amazon.co.uk/kindle-library*
// @match        https://read.amazon.ca/kindle-library*
// @match        https://read.amazon.com.au/kindle-library*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.xmlHttpRequest
// @grant        GM.info
// @connect      goodreads.com
// @connect      amazon.com
// @connect      amazon.co.uk
// @connect      amazon.ca
// @connect      amazon.com.au
// @run-at       document-end
// ==/UserScript==

// Userscripts, the free script app for iPhone and iPad, only has GM.getValue and friends, which make you wait for an answer.
// This loads the saved values first, then hands the script the same GM_ functions Tampermonkey has.
// In Tampermonkey the real functions pass straight through and nothing waits.
(async () => {
const TM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
const cache = {};
if (!TM && typeof GM !== 'undefined' && GM.getValue) {
  let keys = ['grUser', 'kindle', 'kindleHost', 'owned', 'prices'];
  try { if (GM.listValues) keys = [...new Set([...keys, ...await GM.listValues()])]; } catch {}
  for (const k of keys) { try { const v = await GM.getValue(k); if (v !== undefined) cache[k] = v; } catch {} }
}
const api = TM ? [GM_getValue, GM_setValue] : [(k, d) => k in cache ? cache[k] : d, (k, v) => { cache[k] = v; try { GM.setValue(k, v); } catch {} }];
api.push(typeof GM_addStyle === 'function' ? GM_addStyle : css => { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); return st; });
api.push(typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : d => GM.xmlHttpRequest(d));
api.push(typeof GM_info !== 'undefined' ? GM_info : GM.info);
(function (GM_getValue, GM_setValue, GM_addStyle, GM_xmlhttpRequest, GM_info) {
'use strict';
const SITE_URL = 'https://bookshelf.kirbee213.tv/';
const host = location.hostname;
const onKindle = /^read\.amazon\./.test(host);
const onGoodreads = host === 'www.goodreads.com';
const onCalc = onGoodreads && location.pathname.replace(/\/$/, '') === '/kindle-calculator';
const onSite = host === 'bookshelf.kirbee213.tv' || (host === 'kirbeeman.github.io' && location.pathname.startsWith('/bookshelfcalc'));

// ---------- core: fetch Goodreads shelves and the Kindle library from any page ----------
function gmGet(url) {
  return new Promise((resolve, reject) => GM_xmlhttpRequest({
    method: 'GET', url, timeout: 30000,
    onload: r => resolve({status: r.status, text: r.responseText, finalUrl: r.finalUrl || url}),
    onerror: () => reject(new Error('network error')),
    ontimeout: () => reject(new Error('timed out')),
  }));
}
const tag = (el, name) => (el.getElementsByTagName(name)[0]?.textContent || '').trim();

async function goodreadsUserId() {
  const saved = GM_getValue('grUser', '');
  if (saved) return saved;
  const r = await gmGet('https://www.goodreads.com/review/list');
  const m = r.finalUrl.match(/\/review\/list\/(\d+)/) || r.text.match(/\/review\/list\/(\d+)/);
  if (!m) throw new Error('sign in at goodreads.com first');
  GM_setValue('grUser', m[1]);
  return m[1];
}
async function shelfRss(id, shelf) {
  const out = [], seen = new Set();
  for (let page = 1; page <= 80; page++) {
    const r = await gmGet(`https://www.goodreads.com/review/list_rss/${id}?shelf=${encodeURIComponent(shelf)}&page=${page}`);
    if (r.status !== 200) throw new Error('rss ' + r.status);
    const x = new DOMParser().parseFromString(r.text, 'text/xml');
    if (x.querySelector('parsererror') || !x.querySelector('channel')) throw new Error('rss unavailable');
    let fresh = 0;
    for (const it of x.getElementsByTagName('item')) {
      const bid = tag(it, 'book_id') || tag(it, 'guid');
      if (seen.has(bid)) continue; seen.add(bid); fresh++;
      out.push({title: tag(it, 'title'), author: tag(it, 'author_name'), isbn: tag(it, 'isbn'), pages: tag(it, 'num_pages'),
        rating: tag(it, 'user_rating'), dateAdded: tag(it, 'user_date_added'), readAt: tag(it, 'user_read_at')});
    }
    if (!fresh) break;
  }
  return out;
}
async function shelfHtml(id, shelf) {
  const out = [], seen = new Set();
  for (let page = 1; page <= 80; page++) {
    const r = await gmGet(`https://www.goodreads.com/review/list/${id}?shelf=${encodeURIComponent(shelf)}&per_page=100&page=${page}&view=table`);
    if (r.status !== 200) throw new Error(`Goodreads returned ${r.status} for your ${shelf} shelf`);
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    let fresh = 0;
    for (const row of doc.querySelectorAll('tr.review, tr.bookalike')) {
      const a = row.querySelector('td.field.title a'); if (!a) continue;
      const key = a.getAttribute('href'); if (seen.has(key)) continue; seen.add(key); fresh++;
      const val = c => (row.querySelector(`td.field.${c} .value`)?.textContent || '').replace(/\s+/g, ' ').trim();
      out.push({title: (a.getAttribute('title') || a.textContent).trim(), author: row.querySelector('td.field.author a')?.textContent || '',
        isbn: val('isbn'), pages: val('num_pages'), rating: String(row.querySelectorAll('td.field.rating .staticStar.p10').length),
        dateAdded: val('date_added'), readAt: val('date_read')});
    }
    if (!fresh) break;
  }
  return out;
}
async function fetchGoodreads(progress) {
  const id = await goodreadsUserId();
  const shelves = {'to-read': 'unread', 'currently-reading': 'reading', 'read': 'finished'};
  const all = []; let html = false;
  for (const [shelf, status] of Object.entries(shelves)) {
    progress(`Reading your Goodreads "${shelf}" shelf…`);
    let books;
    if (!html) { try { books = await shelfRss(id, shelf); } catch { html = true; } }
    if (html) books = await shelfHtml(id, shelf);
    books.forEach(b => all.push({...b, status}));
  }
  return all;
}
async function fetchKindle(progress) {
  const kHost = GM_getValue('kindleHost', 'read.amazon.com');
  const items = []; let token = '';
  for (let page = 0; page < 400; page++) {
    const r = await gmGet(`https://${kHost}/kindle-library/search?query=&libraryType=BOOKS&sortType=recency&querySize=50` + (token ? '&paginationToken=' + encodeURIComponent(token) : ''));
    let j; try { j = JSON.parse(r.text); } catch { throw new Error(`sign in at ${kHost} first`); }
    if (r.status !== 200 || !j.itemsList) throw new Error(`sign in at ${kHost} first`);
    for (const b of j.itemsList) items.push({asin: b.asin, title: b.title, authors: b.authors, percentageRead: b.percentageRead, originType: b.originType, resourceType: b.resourceType});
    progress(`Reading your Kindle library… ${items.length} books`);
    if (!j.paginationToken) break;
    token = j.paginationToken;
  }
  return items;
}
function gmPost(url, body) {
  return new Promise((resolve, reject) => GM_xmlhttpRequest({
    method: 'POST', url, data: body, timeout: 30000,
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    onload: r => resolve({status: r.status, text: r.responseText}),
    onerror: () => reject(new Error('network error')),
    ontimeout: () => reject(new Error('timed out')),
  }));
}
// Purchase dates (and Kindle's own "Mark as read" flag) from Amazon's Content & Devices page
async function fetchOwnership(progress) {
  const shop = GM_getValue('kindleHost', 'read.amazon.com').replace(/^read\./, 'www.');
  const page = await gmGet(`https://${shop}/hz/mycd/digital-console/contentlist/booksAll/dateDsc/`);
  const token = (page.text.match(/csrfToken\s*[=:]\s*["']([^"']+)/) || [])[1];
  if (!token) throw new Error(`sign in at ${shop} first`);
  const items = []; const BATCH = 100;
  for (let start = 0; start < 5000; start += BATCH) {
    const input = {contentType: 'Ebook', contentCategoryReference: 'booksAll', itemStatusList: ['Active'], showSharedContent: true,
      fetchCriteria: {sortOrder: 'DESCENDING', sortIndex: 'DATE', startIndex: start, batchSize: BATCH, totalContentCount: -1}, surfaceType: 'LargeDesktop'};
    const r = await gmPost(`https://${shop}/hz/mycd/digital-console/ajax`,
      'activity=GetContentOwnershipData&activityInput=' + encodeURIComponent(JSON.stringify(input)) + '&csrfToken=' + encodeURIComponent(token));
    let j; try { j = JSON.parse(r.text).GetContentOwnershipData; } catch { throw new Error('Amazon sent an unexpected reply'); }
    const batch = (j && j.items) || [];
    for (const b of batch) items.push({asin: b.asin, title: b.title, authors: b.authors, acquiredTime: b.acquiredTime, acquiredDate: b.acquiredDate, readStatus: b.readStatus, originType: b.originType, orderId: b.orderId, orderDetailURL: b.orderDetailURL});
    progress(`Reading purchase dates… ${items.length}${j && j.numberOfItems ? ' of ' + j.numberOfItems : ''}`);
    if (batch.length < BATCH || (j.numberOfItems && items.length >= j.numberOfItems)) break;
  }
  if (!items.length) throw new Error('no books found on Content & Devices');
  return items;
}
// Prices paid, read from each order's summary page (only the item price is kept; nothing else from the page is stored)
let pricesPaused = false;
async function fetchPrices(owned, progress, paid = []) {
  const prices = JSON.parse(GM_getValue('prices', '{}') || '{}');
  // Skip books whose price paid is already known (found earlier, or entered/imported on the page): each order is read at most once
  const known = new Set(paid.map(a => String(a).toUpperCase()));
  const todo = owned.filter(i => i.originType === 'Purchase' && i.orderDetailURL && !(i.asin in prices) && !known.has(String(i.asin).toUpperCase()));
  const byOrder = new Map();
  todo.forEach(i => { const k = i.orderId || i.orderDetailURL; if (!byOrder.has(k)) byOrder.set(k, []); byOrder.get(k).push(i); });
  // Up to 150 orders per sync, one at a time with a pause between, so it looks like someone paging through their orders.
  // If Amazon pushes back (robot check, 503 or 429) it stops at once; the rest are read next sync.
  const batch = [...byOrder].slice(0, 150), total = batch.reduce((a, [, b]) => a + b.length, 0);
  let done = 0, n = 0;
  pricesPaused = false;
  for (const [, books] of batch) {
    progress(`Reading prices paid… ${done} of ${total}`);
    try {
      const r = await gmGet(books[0].orderDetailURL);
      if (r.status === 503 || r.status === 429 || /validateCaptcha|Enter the characters you see/i.test(r.text)) { pricesPaused = true; break; }
      const doc = new DOMParser().parseFromString(r.text, 'text/html');
      doc.querySelectorAll('script, style, noscript, header, #navbar, #navFooter').forEach(n => n.remove());
      const text = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ');
      const money = s => +s.replace(/[^\d.]/g, '');
      for (const b of books) {
        let price = null;
        const key = String(b.title || '').slice(0, 30);
        const at = key ? text.indexOf(key) : -1;
        if (at >= 0) { const m = text.slice(at).match(/Sold by:[^$]{0,200}?\$\s?(\d[\d,]*\.\d\d)/); if (m) price = money(m[1]); }
        if (price == null && books.length === 1) { const m = text.match(/Item\(s\) Subtotal:\s*\$\s?(\d[\d,]*\.\d\d)/); if (m) price = money(m[1]); }
        prices[b.asin] = price; // null = looked, nothing found; not retried
        done++;
      }
    } catch { /* network hiccup: try this order again next sync */ }
    if (++n % 10 === 0) GM_setValue('prices', JSON.stringify(prices)); // keep what's found if the tab is closed mid-way
    await new Promise(res => setTimeout(res, 450 + Math.random() * 300));
  }
  GM_setValue('prices', JSON.stringify(prices));
  return prices;
}
// Facts from a book's Amazon page: today's Kindle price (for Kindle Unlimited books, the "to buy" price),
// print length in pages, and Amazon's categories for the book (used to pick a genre).
function parseBookInfo(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach(n => n.remove());
  const text = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ');
  const num = s => { const m = String(s || '').match(/\$\s?(\d[\d,]*\.\d\d)/); return m ? +m[1].replace(/,/g, '') : null; };
  const price = (() => {
    const sw = doc.querySelector('#tmm-grid-swatch-KINDLE, #tmmSwatches .swatchElement.selected, #formats');
    const swText = sw ? sw.textContent.replace(/\s+/g, ' ') : '';
    let m = swText.match(/\$\s?[\d,]*\.\d\d\s*or\s*\$\s?(\d[\d,]*\.\d\d)\s*to buy/i) || text.match(/Kindle\s*\$\s?[\d,]*\.\d\d\s*or\s*\$\s?(\d[\d,]*\.\d\d)\s*to buy/i);
    if (m) return +m[1].replace(/,/g, '');
    for (const sel of ['#kindleALCAccordion_desktop_price_content', '#priceBlock-outsideOfForm_feature_div', '#kindle-price', '#corePriceDisplay_desktop_feature_div .a-offscreen', '#corePrice_feature_div .a-offscreen']) {
      const e = doc.querySelector(sel); const v = e && num(e.textContent); if (v != null) return v;
    }
    const v = num(swText); if (v != null && v > 0) return v;
    m = text.match(/Kindle Price:?\s*\$\s?(\d[\d,]*\.\d\d)/i); // phone layout of the book page
    if (m) return +m[1].replace(/,/g, '');
    m = text.match(/(?:^|\s)Kindle\s*\$\s?(\d[\d,]*\.\d\d)(?!\s*or)/);
    return m ? +m[1].replace(/,/g, '') : null;
  })();
  const pagesEl = doc.querySelector('#rpi-attribute-book_details-ebook_pages .rpi-attribute-value');
  const pm = (pagesEl ? pagesEl.textContent : '').match(/([\d,]+)\s*pages/i) || text.match(/Print length\s*:?[^\d]{0,6}([\d,]+)\s*pages/i);
  const pages = pm ? +pm[1].replace(/,/g, '') : null;
  const crumbs = doc.querySelector('#wayfinding-breadcrumbs_feature_div');
  const cats = [];
  if (crumbs) cats.push(crumbs.textContent.replace(/\s+/g, ' ').trim());
  for (const m of text.matchAll(/#[\d,]+ in ([^#(]{3,80}?)(?= \(| #|$)/g)) if (!/^Kindle Store$/i.test(m[1].trim())) cats.push(m[1].trim());
  // The trail as separate steps, and the best-seller lists, so the page can use Amazon's genre names as they are
  const trail = crumbs ? [...crumbs.querySelectorAll('li a')].map(a => a.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
  const best = cats.slice(crumbs ? 1 : 0).map(c => c.replace(/\s*Customer Reviews.*$/i, '').trim());
  return {price, pages, cats: cats.slice(0, 6), trail, best: best.slice(0, 5)};
}
const KLC_CORE = {
  // Look up a few books' Amazon pages. blocked = Amazon asked for a CAPTCHA, so stop for now.
  async bookInfo(asins) {
    const shop = GM_getValue('kindleHost', 'read.amazon.com').replace(/^read\./, 'www.');
    const info = {};
    for (const a of asins) {
      try {
        const r = await gmGet(`https://${shop}/dp/${encodeURIComponent(a)}`);
        if (/validateCaptcha|Enter the characters you see/i.test(r.text)) return {info, blocked: true};
        info[a] = r.status === 200 ? parseBookInfo(r.text) : {price: null, pages: null, cats: []};
      } catch { /* try again next time */ }
      await new Promise(res => setTimeout(res, 700));
    }
    return {info, blocked: false};
  },
  // force = the Sync now button: always refresh the Kindle list. Otherwise reuse it for 6 hours.
  async sync(force, progress = () => {}, paid = []) {
    const out = {goodreads: [], grErr: '', kindle: null, kErr: ''};
    try { out.goodreads = await fetchGoodreads(progress); } catch (e) { out.grErr = e.message || String(e); }
    let k = null; try { k = JSON.parse(GM_getValue('kindle', 'null')); } catch {}
    if (force || !k || Date.now() - k.time > 6 * 3600e3) {
      try { progress('Reading your Kindle library…'); k = {time: Date.now(), items: await fetchKindle(progress)}; GM_setValue('kindle', JSON.stringify(k)); }
      catch (e) { out.kErr = e.message || String(e); }
    }
    out.kindle = k;
    let o = null; try { o = JSON.parse(GM_getValue('owned', 'null')); } catch {}
    if (force || !o || o.v !== 3 || Date.now() - o.time > 24 * 3600e3) {  // v3 = includes order links (prices) and authors (library fallback)
      try { progress('Reading purchase dates…'); o = {v: 3, time: Date.now(), items: await fetchOwnership(progress)}; GM_setValue('owned', JSON.stringify(o)); }
      catch (e) { out.oErr = e.message || String(e); }
    }
    out.owned = o;
    if (o && o.items) {
      try { out.prices = await fetchPrices(o.items, progress, paid); out.pPaused = pricesPaused; } catch (e) { out.pErr = e.message || String(e); }
    }
    return out;
  },
};

// ---------- 1. On the website: answer the page's sync requests ----------
if (onSite) {
  const post = m => window.postMessage(Object.assign({klc: 1}, m), location.origin);
  window.addEventListener('message', async e => {
    const d = e.data;
    if (!d || d.klc !== 1 || (e.origin && e.origin !== location.origin)) return;
    if (d.type === 'hello') post({type: 'ready', version: GM_info.script.version});
    else if (d.type === 'binfo') {
      const data = await KLC_CORE.bookInfo((d.asins || []).slice(0, 20));
      post({type: 'binfoResult', id: d.id, data: JSON.stringify(data)});
    }
    else if (d.type === 'sync') {
      const data = await KLC_CORE.sync(!!d.force, msg => post({type: 'progress', msg}), d.paid || []);
      post({type: 'result', data: JSON.stringify(data)});
    }
  });
  post({type: 'ready', version: GM_info.script.version});
  return;
}

function badge(html) {
  GM_addStyle(`#klc-badge{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1b1e20;color:#f2f2ee;font:600 13px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.25);max-width:320px}#klc-badge a{color:#9fb0ff;text-decoration:underline}#klc-badge button{all:unset;cursor:pointer;margin-left:10px;opacity:.6}`);
  let el = document.getElementById('klc-badge');
  if (!el) { el = document.createElement('div'); el.id = 'klc-badge'; document.body.appendChild(el); }
  el.innerHTML = html + '<button aria-label="Close">×</button>';
  el.querySelector('button').onclick = () => el.remove();
}

// ---------- 2. On the Kindle library page: refresh the cached Kindle list (optional; the website fetches it too) ----------
if (onKindle) {
  GM_setValue('kindleHost', host);
  (async () => {
    badge('Syncing your Kindle library…');
    try {
      const items = await fetchKindle(msg => badge(msg));
      GM_setValue('kindle', JSON.stringify({time: Date.now(), items}));
      badge(`Kindle library synced: ${items.length} books. <a href="${SITE_URL}">Open calculator</a>`);
    } catch (e) {
      badge(`Couldn't read your Kindle library (${e.message}). Reload the page to try again.`);
    }
  })();
  return;
}

// Remember the signed-in Goodreads user id (read from the site header)
const me = document.querySelector('header a[href*="/user/show/"], nav a[href*="/user/show/"], a[href*="/user/show/"]');
const meId = me && (me.getAttribute('href').match(/\/user\/show\/(\d+)/) || [])[1];
if (meId) GM_setValue('grUser', meId);

// ---------- 3. Anywhere else on Goodreads: a small link to the calculator ----------
if (!onCalc) {
  GM_addStyle(`#klc-open{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1b1e20;color:#f2f2ee!important;font:600 13px/1 system-ui,sans-serif;padding:10px 14px;border-radius:8px;text-decoration:none!important;box-shadow:0 4px 18px rgba(0,0,0,.25)}#klc-open:hover{background:#27408b}`);
  const a = document.createElement('a'); a.id = 'klc-open'; a.href = SITE_URL; a.textContent = 'Shelf of Shame';
  document.body.appendChild(a);
  return;
}

// ---------- 4. goodreads.com/kindle-calculator: the calculator drawn inside Goodreads (kept for older links) ----------
document.title = 'Shelf of Shame';
document.querySelectorAll('link[rel="stylesheet"], style').forEach(n => n.remove());
const font = document.createElement('link'); font.rel = 'stylesheet';
font.href = 'https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,400;7..72,600;7..72,800&family=JetBrains+Mono:wght@400;600&display=swap';
document.head.appendChild(font);
document.body.removeAttribute('class');
document.body.removeAttribute('style');
document.body.innerHTML = `/*BODY*/`;
GM_addStyle(`/*CSS*/`);

/*CALC*/
})(...api);
})();
