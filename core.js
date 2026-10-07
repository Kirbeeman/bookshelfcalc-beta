(function (GM_getValue, GM_setValue, GM_addStyle, GM_xmlhttpRequest, GM_info, SITE_URL) {
'use strict';
const host = location.hostname;
const onKindle = /^read\.amazon\./.test(host);
const onGoodreads = host === 'www.goodreads.com';
const onCalc = onGoodreads && location.pathname.replace(/\/$/, '') === '/kindle-calculator';
const onSite = location.origin + '/' === SITE_URL || (host === 'kirbeeman.github.io' && location.pathname.startsWith('/bookshelfcalc'));

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
    for (const b of j.itemsList) items.push({asin: b.asin, title: unHtml(b.title), authors: unHtml(b.authors), percentageRead: b.percentageRead, originType: b.originType, resourceType: b.resourceType});
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
// Amazon sends some titles and authors with HTML codes left in ("Quick &amp; Easy"); turn them back into characters
function unHtml(s) {
  if (s == null) return s;
  if (Array.isArray(s)) return s.map(unHtml);
  return String(s).replace(/&(?:(amp)|(lt)|(gt)|(quot)|(#39|apos)|#(\d+)|#x([0-9a-f]+));/gi, (m, a, l, g, q, ap, d, x) => a ? '&' : l ? '<' : g ? '>' : q ? '"' : ap ? "'" : String.fromCodePoint(d ? +d : parseInt(x, 16)));
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
    for (const b of batch) items.push({asin: b.asin, title: unHtml(b.title), authors: unHtml(b.authors), acquiredTime: b.acquiredTime, acquiredDate: b.acquiredDate, readStatus: b.readStatus, originType: b.originType, orderId: b.orderId, orderDetailURL: b.orderDetailURL});
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
document.body.innerHTML = `<div class="wrap">
  <header class="top">
    <div class="brand">
      <h1>Shelf of Shame</h1>
      <div class="store st-none" id="store"><i></i><span>Example library</span></div>
      <div class="store st-wait" id="sync" hidden><i></i><span>Not synced yet</span></div>
    </div>
    <div class="actions">
      <button class="btn primary" id="btnSync" hidden>Sync now</button>
      <button class="btn" id="btnAdd">Add book</button>
      <button class="btn" id="btnSettings">Settings</button>
    </div>
  </header>

  <div class="banner" id="demoBanner">
    <p><strong>This is an example library</strong> of public-domain classics so you can see how it works. Your first sync replaces it with your Kindle library and Goodreads shelves.</p>
    <div class="row"><button class="btn primary" id="bannerImport">Set up sync</button><button class="btn" id="bannerEmpty">Start empty</button></div>
  </div>

  <div class="notice" id="notice" role="note">
    <p><strong>Heads up: this calculator is good, not perfect.</strong> It works with whatever Amazon and Goodreads are willing to share, so a few titles won't match up, and some genres, page counts and prices are best guesses. Click any book's title to fix it. Your edits always win and are never overwritten by a sync.</p>
    <button type="button" class="x" id="noticeClose" aria-label="Dismiss this note">×</button>
  </div>

  <section class="yearstrip" aria-label="This year so far">
    <h3 id="yrH">This year</h3>
    <div class="ys"><span class="v" id="yrBooks">0</span><span class="l" id="yrBooksL">books added</span></div>
    <div class="ys"><button type="button" class="reveal" data-reveal><span class="v" id="yrSpent">$0</span></button><span class="l" id="yrSpentL">spent this year</span></div>
    <div class="ys"><button type="button" class="reveal" data-reveal><span class="v" id="yrMonth">$0</span></button><span class="l">a month, on average</span></div>
    <div class="ys"><button type="button" class="reveal" data-reveal><span class="v" id="yrAll">$0</span></button><span class="l" id="yrAllL">spent in all</span></div>
  </section>
  <section class="tiles" aria-label="Library summary">
    <div class="tile"><h3>Books</h3><div class="big" id="tBooks">0</div><div class="sub" id="tBooksSub"></div></div>
    <div class="tile"><h3>Library value</h3><button type="button" class="reveal" id="revealValue" aria-pressed="false"><span class="big" id="tValue">$0</span><span class="sub" id="tValueSub"></span><span class="hint" id="revealHint">Click to reveal</span></button></div>
    <div class="tile time"><h3>Time to read it all</h3><div class="big" id="tHours">0 h</div><div class="sub" id="tHoursSub"></div></div>
    <div class="tile shame"><h3>Unread</h3><div class="big" id="tUnread">0%</div><div class="sub" id="tUnreadSub"></div></div>
  </section>

  <section class="pile" aria-labelledby="pileH">
    <div>
      <div class="pile-head"><h3>Shelf of Shame</h3><h2 class="pile-title" id="pileH">0 unread books</h2><div class="shelfbar"><div class="newnote" id="pileNew" hidden></div><span class="seglabel">Spine color <span class="seg" role="group" aria-label="Spine color"><button type="button" id="spDefault" aria-pressed="true">Default</button><button type="button" id="spGenre" aria-pressed="false">By genre</button></span></span></div><span class="genrestatus" id="genreStatus" hidden></span></div>
      <div id="stack"></div>
      <div class="genrelegend" id="genreLegend" hidden></div>
    </div>
    <div class="pile-facts">
      <p class="verdict" id="verdict"></p>
      <div>
        <div class="meter" id="meter" aria-hidden="true"></div>
        <div class="legend" id="meterLegend" style="margin-top:8px"></div>
      </div>
      <div class="shelfbar" style="justify-content:flex-start"><span class="seglabel">Reading pace <span class="seg" role="group" aria-label="Reading pace"><button type="button" data-pace="slow" aria-pressed="false">Slow</button><button type="button" data-pace="average" aria-pressed="true">Average</button><button type="button" data-pace="fast" aria-pressed="false">Fast</button></span></span><span class="seglabel" id="paceNote"></span></div>
      <div class="facts">
        <div class="fact"><button type="button" class="reveal" data-reveal><span class="v" id="fValue">$0</span></button><span class="l">spent on books you haven't opened</span></div>
        <div class="fact"><span class="v" id="fHours">0 h</span><span class="l">of reading sitting on the shelf</span></div>
        <div class="fact"><span class="v" id="fClear">—</span><span class="l" id="fClearL">shelf cleared at your pace</span></div>
        <div class="fact"><span class="v" id="fOldest">—</span><span class="l" id="fOldestL">oldest unread book</span></div>
        <div class="fact"><span class="v" id="fReading">0</span><span class="l" id="fReadingL">started but not finished</span></div>
        <div class="fact"><span class="v" id="fRate">—</span><span class="l">bought vs finished, last 12 months</span></div>
      </div>
    </div>
  </section>

  <section class="grid3">
    <div class="card"><h3>By status</h3><div class="statlist" id="statusList"></div></div>
    <div class="card"><h3>Books added per year</h3><div class="bars" id="years"></div><div class="rings" id="yearRings" aria-live="polite"></div><div class="yearinfo" id="yearInfo"></div><div class="legend" id="yearLegend"></div></div>
    <div class="card"><h3>Most-owned authors</h3><div class="authors" id="authors"></div></div>
  </section>

  <section class="shelf" aria-labelledby="shelfH">
    <div class="toolbar">
      <h2 id="shelfH">Your library</h2>
      <div class="row"><input type="search" id="q" placeholder="Search title or author" aria-label="Search"><select id="tagSel" aria-label="Filter by tag" hidden></select><button class="btn" id="btnXlsx" type="button">Export spreadsheet</button></div>
    </div>
    <div class="seg libtabs" id="libTabs" role="tablist" hidden></div>
    <div class="chips" id="chips"></div>
    <div class="tablewrap">
      <table>
        <thead><tr>
          <th><button data-k="title">Title</button></th>
          <th><button data-k="status">Status</button></th>
          <th><button data-k="progress">Progress</button></th>
          <th class="r"><button data-k="pages">Pages</button></th>
          <th class="r"><button data-k="price">Price</button></th>
          <th><button data-k="date">Added</button></th>
          <th><button data-k="rating">Rating</button></th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <button class="btn showmore" id="showMore" hidden>Show more</button>
  </section>
</div>

<!-- Import -->
<dialog id="dlgImport">
  <form class="dlg" method="dialog" id="importForm">
    <div class="dlg-head"><h2>Import your books</h2><button class="x" value="cancel" aria-label="Close">×</button></div>
    <div class="tabs" role="tablist" id="impTabs">
      <button type="button" class="tab" role="tab" data-t="goodreads" aria-selected="true">Goodreads</button>
      <button type="button" class="tab" role="tab" data-t="amazon" aria-selected="false">Amazon orders</button>
      <button type="button" class="tab" role="tab" data-t="csv" aria-selected="false">Any CSV / backup</button>
    </div>
    <div data-p="goodreads">
      <ol class="steps">
        <li>On goodreads.com go to <strong>My Books → Import and export → Export library</strong>.</li>
        <li>Download the CSV and drop it here. Shelves map to status: to-read is unread, currently-reading is reading, read is finished.</li>
      </ol>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="grKindleOnly"> Only import Kindle editions</label>
    </div>
    <div data-p="amazon" hidden>
      <ol class="steps">
        <li>Request your data at <strong>amazon.com/hz/privacy-central/data-requests</strong> (choose Kindle / Digital orders).</li>
        <li>When the email arrives, unzip it and find the digital orders CSV (for example <span class="num">Digital Items.csv</span>).</li>
        <li>Drop it here. Prices and purchase dates get matched onto books you already imported by ASIN or title.</li>
      </ol>
    </div>
    <div data-p="csv" hidden>
      <p class="note" style="font-size:.88rem">Any CSV with a header row works. Recognised columns: <span class="num">title, author, asin, pages, price, date, status, progress, rating, source</span>. Status can be unread, reading, finished or abandoned. A backup file from this page also goes here.</p>
    </div>
    <div class="drop" id="drop">Drop the file here, or <label style="color:var(--accent);cursor:pointer;text-decoration:underline">choose a file<input type="file" id="file" accept=".json,.csv,.txt,.xml,text/csv,application/json,text/xml" hidden></label></div>
    <textarea id="paste" hidden></textarea>
    <label class="check"><input type="checkbox" id="replace"> Replace my current library instead of merging</label>
    <div class="dlg-foot"><span class="result" id="impResult"></span><button type="button" class="btn primary" id="doImport">Import</button></div>
  </form>
</dialog>

<!-- Edit -->
<dialog id="dlgEdit">
  <form class="dlg" id="editForm">
    <div class="dlg-head"><h2 id="editH">Edit book</h2><button type="button" class="x" id="editClose" aria-label="Close">×</button></div>
    <div class="form">
      <label class="full">Title<input type="text" id="eTitle" required></label>
      <label>Author<input type="text" id="eAuthor"></label>
      <label>ASIN<input type="text" id="eAsin"></label>
      <label>Status<select id="eStatus"><option value="unread">Unread</option><option value="reading">Reading</option><option value="finished">Finished</option><option value="abandoned">DNF (Did Not Finish)</option></select></label>
      <label>Progress %<input type="number" id="eProgress" min="0" max="100" step="1"></label>
      <label>Pages<input type="number" id="ePages" min="0" step="1" placeholder="unknown"></label>
      <label>Price paid<input type="number" id="ePrice" min="0" step="0.01" placeholder="unknown"></label>
      <label>Added on<input type="date" id="eDate"></label>
      <label>How you got it<select id="eSource"><option value="purchase">Bought</option><option value="free">Free</option><option value="ku">Kindle Unlimited</option><option value="prime">Prime Reading</option><option value="sample">Sample</option><option value="device">Came with my Kindle (dictionary or guide)</option><option value="shared">Shared with me (Family Library)</option><option value="other">Borrowed / other</option></select></label>
      <label>Genre<select id="eGenre"></select></label>
      <label>Second genre<select id="eGenre2"></select></label>
      <p class="etags" id="eTags" hidden></p>
      <label>Rating<select id="eRating"><option value="0">No rating</option><option value="1">★</option><option value="2">★★</option><option value="3">★★★</option><option value="4">★★★★</option><option value="5">★★★★★</option></select></label>
    </div>
    <div class="dlg-foot">
      <div class="row"><button type="button" class="btn danger" id="eDelete">Delete</button><span class="result err" id="eConfirm"></span></div>
      <button type="submit" class="btn primary">Save</button>
    </div>
  </form>
</dialog>

<!-- Settings -->
<dialog id="dlgSettings">
  <form class="dlg" id="setForm">
    <div class="dlg-head"><h2>Settings</h2><button type="button" class="x" id="setClose" aria-label="Close">×</button></div>
    <div class="themesect"><h4>Theme</h4><div class="themepick" role="radiogroup" aria-label="Theme" id="themePick"></div></div>
    <div class="form">
      <label>Pages to assume when unknown<input type="number" id="sPages" min="1"></label>
      <label>Price to assume when unknown<input type="number" id="sPrice" min="0" step="0.01"></label>
      <label>Minutes per page<input type="number" id="sMin" min="0.2" step="0.1"></label>
      <label>Pages you read per day<input type="number" id="sDay" min="1"></label>
      <label>Currency<select id="sCur"><option>USD</option><option>GBP</option><option>EUR</option><option>CAD</option><option>AUD</option><option>JPY</option><option>INR</option><option>BRL</option><option>MXN</option></select></label>
      <label>Finished when progress reaches %<input type="number" id="sDone" min="50" max="100"></label>
      <label class="check full"><input type="checkbox" id="sBorrowed"> Count Kindle Unlimited, Prime, borrowed and family-shared books</label>
      <label class="check full"><input type="checkbox" id="sSharedTab"> Show shared and borrowed books on their own tab under Your library</label>
      <label class="check full"><input type="checkbox" id="sSamples"> Count samples</label>
      <label class="check full"><input type="checkbox" id="sGrAll"> Include Goodreads books that aren't in my Kindle library</label>
      <label class="check full"><input type="checkbox" id="sExtras"> Count the dictionaries and user guides that came with your Kindle</label>
    </div>
    <p class="note">Kindle doesn't report page counts or prices, so unknown values use the numbers above. Values you enter per book always win. About one minute per page is typical for adult fiction.</p>
    <div class="files"><h4>Files and backups</h4><p class="note">Only needed if you don't use the sync script, or to move your library to another browser.</p><div class="row"><button type="button" class="btn" id="btnImport">Import a file</button><button type="button" class="btn" id="btnExport">Back up library</button></div></div>
    <div class="dlg-foot"><div class="row"><button type="button" class="btn danger" id="wipe">Delete all books</button><span class="result err" id="wipeConfirm"></span></div><button type="submit" class="btn primary">Save</button></div>
    <p class="verline" id="verLine"></p>
  </form>
</dialog>

<div id="toast" role="status" aria-live="polite"></div>

`;
GM_addStyle(`
/* Layout: e-paper ledger — summary strip, the pile itself as the centerpiece, breakdowns, then the full shelf table. */
:root{
  --bg:#eceeea; --paper:#f7f8f5; --ink:#1b1e20; --muted:#5d6560; --rule:#cfd4ce;
  --accent:#27408b; --accent-soft:#dde3f4; --shame:#a3322a; --shame-soft:#f3dedb;
  --ok:#2f6b45; --warn:#9a6a12;
  --cloth-1:#b04a32; --cloth-2:#2f6f86; --cloth-3:#a8741f; --cloth-4:#34466e; --cloth-5:#7e4f33; --cloth-6:#4c7a46; --spine-ink:#f7f1e3; --wood:#b8743c; --wood-dark:#7a4a24; --wood-back:#efe4cf;
  --g-mystery:#2f3e5c; --g-romance:#a3445f; --g-erotica:#7b3f7a; --g-scifi:#2f6f86; --g-fantasy:#4c6fb3; --g-horror:#5b2330; --g-fiction:#7a6440; --g-history:#7a4a2a; --g-selfhelp:#3f6b4f; --g-cooking:#8a7a2e; --g-humor:#b8692a; --g-kids:#6f5aa0; --g-comics:#b0472f; --g-nonfiction:#4f5d63; --g-unknown:#8d8a84;
  --display:"Literata", Georgia, "Times New Roman", serif;
  --body:"Literata", Georgia, serif;
  --mono:"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#121517; --paper:#1a1e21; --ink:#e7e8e3; --muted:#9aa29c; --rule:#2d3336;
  --accent:#9fb0ff; --accent-soft:#232c4a; --shame:#f08a7e; --shame-soft:#3a2220;
  --ok:#7fc89a; --warn:#e2b458;
  --cloth-1:#a04a36; --cloth-2:#2f7386; --cloth-3:#a37a2c; --cloth-4:#3e5285; --cloth-5:#86573a; --cloth-6:#4d7b4a; --spine-ink:#f6f3ea; --wood:#8a5630; --wood-dark:#4a2e19; --wood-back:#231c17;
  --g-mystery:#41558a; --g-romance:#b8577a; --g-erotica:#a0609e; --g-scifi:#3a8aa6; --g-fantasy:#6587d0; --g-horror:#7a3040; --g-fiction:#93794c; --g-history:#95603a; --g-selfhelp:#4f8a63; --g-cooking:#a09033; --g-humor:#c97a35; --g-kids:#8670bd; --g-comics:#c45a3e; --g-nonfiction:#64757d; --g-unknown:#6f6c67;
  color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#121517; --paper:#1a1e21; --ink:#e7e8e3; --muted:#9aa29c; --rule:#2d3336;
  --accent:#9fb0ff; --accent-soft:#232c4a; --shame:#f08a7e; --shame-soft:#3a2220;
  --ok:#7fc89a; --warn:#e2b458;
  --cloth-1:#a04a36; --cloth-2:#2f7386; --cloth-3:#a37a2c; --cloth-4:#3e5285; --cloth-5:#86573a; --cloth-6:#4d7b4a; --spine-ink:#f6f3ea; --wood:#8a5630; --wood-dark:#4a2e19; --wood-back:#231c17;
  --g-mystery:#41558a; --g-romance:#b8577a; --g-erotica:#a0609e; --g-scifi:#3a8aa6; --g-fantasy:#6587d0; --g-horror:#7a3040; --g-fiction:#93794c; --g-history:#95603a; --g-selfhelp:#4f8a63; --g-cooking:#a09033; --g-humor:#c97a35; --g-kids:#8670bd; --g-comics:#c45a3e; --g-nonfiction:#64757d; --g-unknown:#6f6c67;
  color-scheme:dark}

/* ---------- themes (Settings → Theme). Default follows the device's light/dark setting. ---------- */
/* Cozy: a lamp-lit reading room. Warm dark wood, parchment text, amber light. */
:root[data-theme="cozy"]{
  --bg:#16100b; --paper:#211811; --ink:#f2e6cf; --muted:#b9a383; --rule:#3b2c1f;
  --accent:#f0b25a; --accent-soft:#3b2915; --shame:#ec8a62; --shame-soft:#3e2116;
  --ok:#b5cf8f; --warn:#f0b85c;
  --cloth-1:#7d3a2c; --cloth-2:#3d5848; --cloth-3:#8b6a35; --cloth-4:#5b3b52; --cloth-5:#9b5a2c; --cloth-6:#4d3a28; --spine-ink:#f7e8c9; --wood:#6f4223; --wood-dark:#3c2211; --wood-back:#1b110a;
  --g-mystery:#41558a; --g-romance:#b8577a; --g-erotica:#a0609e; --g-scifi:#3a8aa6; --g-fantasy:#6587d0; --g-horror:#7a3040; --g-fiction:#93794c; --g-history:#95603a; --g-selfhelp:#4f8a63; --g-cooking:#a09033; --g-humor:#c97a35; --g-kids:#8670bd; --g-comics:#c45a3e; --g-nonfiction:#64757d; --g-unknown:#6f6c67;
  --display:"Cormorant Garamond", "Literata", Georgia, serif;
  color-scheme:dark}
:root[data-theme="cozy"] body{background:radial-gradient(ellipse 70% 55% at 50% -8%, rgba(255,176,84,.22), transparent 70%), radial-gradient(ellipse 50% 40% at 100% 100%, rgba(255,140,60,.07), transparent 70%), var(--bg);background-attachment:fixed}
:root[data-theme="cozy"] h1{font-weight:700;font-size:2rem;letter-spacing:0}
:root[data-theme="cozy"] .card,:root[data-theme="cozy"] .tiles{box-shadow:0 10px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,210,150,.05)}
:root[data-theme="cozy"] .bookcase{box-shadow:0 0 60px rgba(255,160,70,.12), inset 0 18px 30px rgba(0,0,0,.45)}
:root[data-theme="cozy"] .btn.primary{background:var(--accent);color:#1c1209;border-color:var(--accent)}
:root[data-theme="cozy"] header.top{background:rgba(22,16,11,.92);backdrop-filter:blur(6px)}
/* Zon: an online-bookstore look. Navy header with a darker strip under it, white boxes on a gray page,
   yellow pill buttons, teal links, orange stars and highlights, red prices, plain sans-serif type everywhere. */
:root[data-theme="zon"]{
  --bg:#e3e6e6; --paper:#ffffff; --ink:#0f1111; --muted:#565959; --rule:#d5d9d9;
  --accent:#007185; --accent-soft:#e6f2f4; --shame:#b12704; --shame-soft:#fbeae5;
  --ok:#007600; --warn:#de7921;
  --wood:#a5774f; --wood-dark:#6e4a2e; --wood-back:#f3ece2;
  --display:Arial, "Helvetica Neue", Helvetica, sans-serif; --body:Arial, "Helvetica Neue", Helvetica, sans-serif; --mono:Arial, "Helvetica Neue", Helvetica, sans-serif;
  color-scheme:light}
:root[data-theme="zon"] body{font-size:14px;line-height:1.4}
:root[data-theme="zon"] .num{font-variant-numeric:tabular-nums}
:root[data-theme="zon"] header.top{background:#131921;color:#fff;border-bottom:0;padding-block:10px;box-shadow:0 0 0 100vmax #131921;clip-path:inset(0 -100vmax)}
:root[data-theme="zon"] header.top h1{font-size:1.45rem;font-weight:700;letter-spacing:-.01em}
:root[data-theme="zon"] header.top .store,:root[data-theme="zon"] header.top a{color:#ccc}
:root[data-theme="zon"] header.top .btn{background:transparent;color:#fff;border:1px solid transparent;box-shadow:none;border-radius:2px;font-weight:700}
:root[data-theme="zon"] header.top .btn:hover{border-color:#fff}
:root[data-theme="zon"] header.top .btn.primary{background:#ffd814;color:#0f1111;border-color:#fcd200;border-radius:100px}
/* the Sync line becomes the second, lighter navy strip under the header */
:root[data-theme="zon"] .card.synccard{margin-top:-28px;background:#232f3e;color:#fff;border:0;border-radius:0;box-shadow:0 0 0 100vmax #232f3e;clip-path:inset(0 -100vmax);padding-block:6px}
:root[data-theme="zon"] .synccard h3,:root[data-theme="zon"] .synccard .chev{color:#fff;border-top-color:#fff}
:root[data-theme="zon"] .synccard .scsum{color:#ddd}:root[data-theme="zon"] .synccard .scsum[data-k=ok]{color:#7fda8b}:root[data-theme="zon"] .synccard .scsum[data-k=err]{color:#ffb4a2}
:root[data-theme="zon"] .synccard .warnline{background:#37475a;color:#fff}:root[data-theme="zon"] .synccard .warnline a{color:#febd69}:root[data-theme="zon"] .synccard .btn{color:var(--ink)}
:root[data-theme="zon"] .synccard .stage,:root[data-theme="zon"] .synccard .sc-note,:root[data-theme="zon"] .synccard .stage .r{color:#ddd}:root[data-theme="zon"] .synccard .pbar{background:#3a4553}
:root[data-theme="zon"] h3{font-family:var(--body);text-transform:none;letter-spacing:0;font-size:1rem;font-weight:700;color:var(--ink)}
:root[data-theme="zon"] h2{font-weight:700}
:root[data-theme="zon"] .pile-title{font-weight:400;font-size:1.75rem}
:root[data-theme="zon"] .tile .big{font-weight:400;font-size:1.75rem}
:root[data-theme="zon"] .card,:root[data-theme="zon"] .tiles{border:0;border-radius:4px;box-shadow:0 1px 2px rgba(15,17,17,.12)}
:root[data-theme="zon"] .tiles{background:var(--rule)}
:root[data-theme="zon"] .btn{border-radius:100px;border:1px solid #d5d9d9;background:#fff;box-shadow:0 2px 5px rgba(213,217,217,.5);font-weight:400;padding:6px 16px}
:root[data-theme="zon"] .btn:hover{background:#f7fafa}
:root[data-theme="zon"] .btn.primary{background:#ffd814;border-color:#fcd200;color:#0f1111}
:root[data-theme="zon"] .btn.primary:hover{background:#f7ca00;opacity:1}
:root[data-theme="zon"] .seg{border-radius:100px;border-color:#d5d9d9}:root[data-theme="zon"] .seg button[aria-pressed="true"]{background:#ffa41c;color:#0f1111}
:root[data-theme="zon"] input[type=search]{border:1px solid #888c8c;border-radius:8px;box-shadow:0 1px 2px rgba(15,17,17,.15) inset}
:root[data-theme="zon"] input:focus,:root[data-theme="zon"] select:focus{outline:none;border-color:#e77600;box-shadow:0 0 3px 2px rgba(228,121,17,.5)}
:root[data-theme="zon"] a,:root[data-theme="zon"] .hint{color:var(--accent)}
:root[data-theme="zon"] .stars{color:#ffa41c}
:root[data-theme="zon"] .tip{border-bottom-color:var(--accent)}
/* Halloween: purple, slime green and pumpkin orange on near-black */
:root[data-theme="halloween"]{
  --bg:#0c0911; --paper:#16101e; --ink:#eee8f7; --muted:#a99cbd; --rule:#2f2342;
  --accent:#9be35a; --accent-soft:#1d2b13; --shame:#ff8c2e; --shame-soft:#3a1f0b;
  --ok:#b98cff; --warn:#ffb347;
  --cloth-1:#4e2a72; --cloth-2:#2f5d2a; --cloth-3:#8a3f12; --cloth-4:#24202b; --cloth-5:#6a3592; --cloth-6:#46741f; --spine-ink:#f3ecff; --wood:#2c1f36; --wood-dark:#150e1b; --wood-back:#09060d;
  --g-mystery:#41558a; --g-romance:#b8577a; --g-erotica:#a0609e; --g-scifi:#3a8aa6; --g-fantasy:#6587d0; --g-horror:#7a3040; --g-fiction:#93794c; --g-history:#95603a; --g-selfhelp:#4f8a63; --g-cooking:#a09033; --g-humor:#c97a35; --g-kids:#8670bd; --g-comics:#c45a3e; --g-nonfiction:#64757d; --g-unknown:#6f6c67;
  color-scheme:dark}
/* a full moon with a few bats in the top corner, and purple fog rising from the bottom (no spiders, as ordered) */
:root[data-theme="halloween"] body{background:
  radial-gradient(ellipse 90% 45% at 50% 108%, rgba(118,58,190,.32), transparent 70%),
  radial-gradient(ellipse 60% 35% at 10% 100%, rgba(110,200,70,.10), transparent 70%), var(--bg);background-attachment:fixed}
:root[data-theme="halloween"] h1{font-family:"Creepster", "Literata", serif;font-weight:400;font-size:2.2rem;letter-spacing:.03em;color:var(--accent);text-shadow:0 0 12px rgba(155,227,90,.45)}
:root[data-theme="halloween"] header.top{background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='90' viewBox='0 0 180 90'%3E%3Cg fill='%234a3568'%3E%3Cpath d='M20 30c4-6 9-8 14-6-2 3-2 6 0 8 3-3 6-4 8-3l2-4 2 4c2-1 5 0 8 3 2-2 2-5 0-8 5-2 10 0 14 6-6-1-10 1-12 5-3-2-6-2-8 0-2-1-3-1-4 0s-2 1-4 0c-2-2-5-2-8 0-2-4-6-6-12-5z'/%3E%3Cpath transform='translate(95 8) scale(.7)' d='M20 30c4-6 9-8 14-6-2 3-2 6 0 8 3-3 6-4 8-3l2-4 2 4c2-1 5 0 8 3 2-2 2-5 0-8 5-2 10 0 14 6-6-1-10 1-12 5-3-2-6-2-8 0-2-1-3-1-4 0s-2 1-4 0c-2-2-5-2-8 0-2-4-6-6-12-5z'/%3E%3Cpath transform='translate(120 50) scale(.5)' d='M20 30c4-6 9-8 14-6-2 3-2 6 0 8 3-3 6-4 8-3l2-4 2 4c2-1 5 0 8 3 2-2 2-5 0-8 5-2 10 0 14 6-6-1-10 1-12 5-3-2-6-2-8 0-2-1-3-1-4 0s-2 1-4 0c-2-2-5-2-8 0-2-4-6-6-12-5z'/%3E%3C/g%3E%3C/svg%3E") no-repeat calc(50% + 40px) 2px / 150px 75px, radial-gradient(circle at 50% 50%, #f1ecff 0 18px, rgba(205,185,255,.35) 20px, rgba(150,110,230,.12) 30px, transparent 42px), rgba(12,9,17,.92);backdrop-filter:blur(6px)}
:root[data-theme="halloween"] .card,:root[data-theme="halloween"] .tiles{box-shadow:0 0 0 1px rgba(155,100,255,.08), 0 10px 30px rgba(60,20,100,.35)}
:root[data-theme="halloween"] .pile-title{color:var(--shame);text-shadow:0 0 14px rgba(255,140,46,.35)}
:root[data-theme="halloween"] .btn.primary{background:var(--accent);color:#0c0911;border-color:var(--accent)}
:root[data-theme="halloween"] .seg button[aria-pressed="true"]{background:#7b46c4;color:#fff}
:root[data-theme="halloween"] .bookcase{box-shadow:0 0 40px rgba(130,70,210,.25), inset 0 18px 30px rgba(0,0,0,.6)}
/* Light: the default's light colors, whatever the device is set to */
:root[data-theme="light"]{color-scheme:light}
.themesect{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}.themesect h4{margin:0;font-size:.9rem}
.themepick{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
/* Illustrated shelf: ink outline and the dark posts of the bookcase, per theme */
:root{--outline:#2a1e16;--post:#3b3f44}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--outline:#0b0908;--post:#2d3135}}
:root[data-theme="dark"]{--outline:#0b0908;--post:#2d3135}
:root[data-theme="cozy"]{--outline:#0d0805;--post:#2e1e13}
:root[data-theme="zon"]{--outline:#2a1e16;--post:#3b3f44}
:root[data-theme="halloween"]{--outline:#07050a;--post:#261c33}
/* Fruit: frosted glass panels floating over a soft, colourful wallpaper, the phone's own system fonts, pill-shaped
   buttons and bright system colours. Follows the device's light or dark setting. Comes after the shelf colours above so its own win. */
:root[data-theme="fruit"]{
  --bg:#f2f2f7; --paper:#ffffff; --ink:#1d1d1f; --muted:#6e6e73; --rule:#d1d1d6;
  --accent:#007aff; --accent-soft:#e3efff; --shame:#ff3b30; --shame-soft:#ffe6e4;
  --ok:#248a3d; --warn:#c96a00;
  --cloth-1:#ff3b30; --cloth-2:#007aff; --cloth-3:#ff9500; --cloth-4:#5856d6; --cloth-5:#ff2d55; --cloth-6:#34c759; --spine-ink:#ffffff; --wood:#d1d1d6; --wood-dark:#a1a1a6; --wood-back:#f5f5f7;
  --glass:rgba(255,255,255,.58); --glass-edge:rgba(255,255,255,.8); --glass-shade:rgba(0,0,0,.09); --sheet:rgba(250,250,252,.88); --fill:rgba(118,118,128,.12);
  --display:-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --body:-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono:-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --outline:#3a3a3c; --post:#8e8e93;
  color-scheme:light}
@media (prefers-color-scheme: dark){:root[data-theme="fruit"]{
  --bg:#000000; --paper:#1c1c1e; --ink:#f5f5f7; --muted:#98989d; --rule:#38383a;
  --accent:#0a84ff; --accent-soft:#0b2a4a; --shame:#ff453a; --shame-soft:#3a1412;
  --ok:#30d158; --warn:#ff9f0a;
  --cloth-1:#ff453a; --cloth-2:#0a84ff; --cloth-3:#ff9f0a; --cloth-4:#5e5ce6; --cloth-5:#ff375f; --cloth-6:#30d158; --wood:#48484a; --wood-dark:#2c2c2e; --wood-back:#111113;
  --glass:rgba(44,44,48,.55); --glass-edge:rgba(255,255,255,.14); --glass-shade:rgba(0,0,0,.55); --sheet:rgba(30,30,32,.9); --fill:rgba(118,118,128,.24);
  --outline:#000000; --post:#3a3a3c;
  color-scheme:dark}}
:root[data-theme="fruit"] body{background:
  radial-gradient(60% 50% at 8% 0%, rgba(255,149,0,.28), transparent 70%),
  radial-gradient(55% 45% at 96% 8%, rgba(255,45,85,.22), transparent 70%),
  radial-gradient(70% 60% at 85% 100%, rgba(0,122,255,.26), transparent 70%),
  radial-gradient(60% 50% at 0% 92%, rgba(52,199,89,.20), transparent 70%), var(--bg);background-attachment:fixed;-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme: dark){:root[data-theme="fruit"] body{background:
  radial-gradient(60% 50% at 8% 0%, rgba(255,149,0,.30), transparent 70%),
  radial-gradient(55% 45% at 96% 8%, rgba(191,90,242,.30), transparent 70%),
  radial-gradient(70% 60% at 85% 100%, rgba(10,132,255,.32), transparent 70%),
  radial-gradient(60% 50% at 0% 92%, rgba(48,209,88,.18), transparent 70%), var(--bg);background-attachment:fixed}}
:root[data-theme="fruit"] .card,:root[data-theme="fruit"] .tiles,:root[data-theme="fruit"] .yearstrip,:root[data-theme="fruit"] .pile,:root[data-theme="fruit"] .tablewrap,:root[data-theme="fruit"] .notice{background:var(--glass);-webkit-backdrop-filter:blur(28px) saturate(180%);backdrop-filter:blur(28px) saturate(180%);border:1px solid var(--glass-edge);border-radius:22px;box-shadow:0 0 0 .5px var(--glass-shade), 0 14px 36px rgba(0,0,0,.08), inset 0 1px 0 rgba(255,255,255,.35)}
:root[data-theme="fruit"] .tiles{gap:0}
/* each glass panel is its own layer, so the one being hovered comes to the front and its pop-up isn't hidden under the next */
:root[data-theme="fruit"] :is(.card,.tiles,.yearstrip,.pile,.tablewrap,.notice,.banner){position:relative}
:root[data-theme="fruit"] :is(.card,.tiles,.yearstrip,.pile,.tablewrap,.notice,.banner):is(:hover,:focus-within){z-index:4}
:root[data-theme="fruit"] .banner{border-radius:22px;border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);background:color-mix(in srgb,var(--accent-soft) 80%,transparent);-webkit-backdrop-filter:blur(28px) saturate(180%);backdrop-filter:blur(28px) saturate(180%)}
:root[data-theme="fruit"] .notice{border-left-width:4px}
:root[data-theme="fruit"] .tile{background:transparent}
:root[data-theme="fruit"] .tile + .tile{box-shadow:inset 1px 0 0 var(--glass-shade)}
:root[data-theme="fruit"] header.top{background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border-bottom:0;box-shadow:0 0 0 100vmax var(--glass);clip-path:inset(0 -100vmax)}
:root[data-theme="fruit"] h1{font-weight:700;font-size:1.95rem;letter-spacing:-.025em}
:root[data-theme="fruit"] h2{letter-spacing:-.02em}
:root[data-theme="fruit"] h3{font-family:var(--body);text-transform:none;letter-spacing:-.005em;font-size:.95rem;font-weight:600;color:var(--muted)}
:root[data-theme="fruit"] .num,:root[data-theme="fruit"] .tile .big,:root[data-theme="fruit"] td{font-variant-numeric:tabular-nums}
:root[data-theme="fruit"] .tile .big{font-family:var(--display);font-weight:700;letter-spacing:-.02em}
:root[data-theme="fruit"] .pile-title{font-weight:700;letter-spacing:-.025em}
:root[data-theme="fruit"] .btn{border-radius:999px;border:1px solid var(--glass-edge);background:var(--glass);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);box-shadow:0 0 0 .5px var(--glass-shade), 0 2px 6px rgba(0,0,0,.06);padding:7px 16px}
:root[data-theme="fruit"] .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
:root[data-theme="fruit"] .seg{border:0;border-radius:999px;background:var(--fill);padding:2px;gap:2px}
:root[data-theme="fruit"] .seg button{background:transparent;border-radius:999px;color:var(--ink)}
:root[data-theme="fruit"] .seg button[aria-pressed="true"]{background:var(--paper);color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.18)}
:root[data-theme="fruit"] input[type=search],:root[data-theme="fruit"] input[type=text],:root[data-theme="fruit"] input[type=number],:root[data-theme="fruit"] input[type=date],:root[data-theme="fruit"] select,:root[data-theme="fruit"] textarea{background:var(--fill);border:1px solid transparent;border-radius:10px}
:root[data-theme="fruit"] input[type=search]{border-radius:999px;padding-inline:14px}
:root[data-theme="fruit"] input:focus,:root[data-theme="fruit"] select:focus,:root[data-theme="fruit"] textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 30%,transparent)}
:root[data-theme="fruit"] dialog{background:var(--sheet);-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);border:1px solid var(--glass-edge);border-radius:26px;box-shadow:0 30px 80px rgba(0,0,0,.25)}
:root[data-theme="fruit"] dialog::backdrop{background:rgba(0,0,0,.22);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
:root[data-theme="fruit"] .themepick button{border-radius:14px}
:root[data-theme="fruit"] .bookcase{border-radius:14px 14px 0 0;box-shadow:0 14px 36px rgba(0,0,0,.12)}
.themepick button{display:flex;flex-direction:column;gap:6px;align-items:flex-start;border:1px solid var(--rule);background:var(--paper);color:var(--ink);border-radius:8px;padding:8px;font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;text-align:left}
.themepick button[aria-checked="true"]{outline:2px solid var(--accent);outline-offset:1px}
.themepick .sw{display:flex;width:100%;height:28px;border-radius:5px;overflow:hidden;border:1px solid rgba(128,128,128,.3)}
.themepick .sw i{flex:1}
.themepick small{font-weight:400;color:var(--muted);font-size:.72rem;line-height:1.25}
@media (max-width:640px){.themepick{grid-template-columns:repeat(2,minmax(0,1fr))}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{background:var(--bg);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.5;padding-inline:16px;padding-block:0 48px}
.wrap{max-width:1140px;margin:0 auto;display:flex;flex-direction:column;gap:28px}
h1,h2,h3{font-family:var(--display);text-wrap:balance;margin:0;line-height:1.15}
h1{font-size:1.7rem;font-weight:800;letter-spacing:-.01em}
h2{font-size:1.25rem;font-weight:800}
h3{font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-family:var(--mono)}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
button,select,input,textarea{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn{border:1px solid var(--rule);background:var(--paper);padding:7px 14px;border-radius:6px;font-size:.9rem;font-weight:600}
.btn:hover{border-color:var(--ink)}
.btn.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.btn.primary:hover{opacity:.88}
.btn.danger{color:var(--shame)}
.btn.small{padding:4px 10px;font-size:.8rem}

/* header */
header.top{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:var(--bg);border-bottom:1px solid var(--rule);padding-block:14px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.brand{display:flex;flex-direction:column;gap:2px}
.store{font-family:var(--mono);font-size:.74rem;color:var(--muted);display:flex;align-items:center;gap:6px}
/* Status dots use the same colors in every theme: green done, yellow waiting or working, red a problem, gray nothing to report */
.store i{width:7px;height:7px;border-radius:50%;background:#8a8f8b;display:inline-block;flex:none;box-shadow:0 0 0 1px rgba(0,0,0,.28)}
.store.st-ok i,.gdstore[data-k=ok] i{background:#22a55a} .store.st-wait i,.gdstore[data-k=run] i,.gdstore[data-k=tap] i{background:#f0b429} .store.st-bad i,.gdstore[data-k=err] i{background:#e5484d}
.actions{display:flex;flex-wrap:wrap;gap:8px}

.notice{border:1px solid var(--rule);border-left:4px solid var(--warn);background:var(--paper);border-radius:8px;padding:10px 12px 10px 16px;display:flex;gap:12px;align-items:flex-start;justify-content:space-between;font-size:.9rem}
.notice p{margin:0;max-width:80ch}
.notice .x{flex:none}
.banner{background:var(--accent-soft);border:1px solid var(--accent);border-radius:8px;padding:12px 16px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.banner p{margin:0;max-width:70ch}

/* summary */
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:10px;overflow:visible}
.tile:first-child{border-radius:9px 0 0 9px}.tile:last-child{border-radius:0 9px 9px 0}
.tip{position:relative;border-bottom:1px dotted currentColor;cursor:help;outline-offset:2px}
.tipbox{position:absolute;left:0;top:calc(100% + 8px);width:min(290px,78vw);background:var(--ink);color:var(--bg);padding:10px 12px;border-radius:8px;font-size:.8rem;line-height:1.45;z-index:20;opacity:0;visibility:hidden;transition:opacity .12s;box-shadow:0 6px 20px rgba(0,0,0,.25);font-family:var(--body)}
.tipbox ul{margin:6px 0;padding-left:1.1em}
.tip:hover .tipbox,.tip:focus .tipbox,.tip:focus-within .tipbox{opacity:1;visibility:visible}
.tile{background:var(--paper);padding:16px 18px;display:flex;flex-direction:column;gap:4px;min-width:0}
.tile .big{font-family:var(--mono);font-size:1.75rem;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1;overflow-wrap:anywhere}
.tile .unitw{font-size:.55em;font-weight:500;color:var(--muted);font-family:var(--body)}
.trows{display:grid;grid-template-columns:auto 1fr auto;gap:5px 14px;margin-top:8px;align-items:baseline;font-size:.84rem}
.trows .tk{white-space:nowrap}.trows .tn,.trows .th{font-family:var(--mono);white-space:nowrap;text-align:right}.trows .th{font-weight:600}
.trows .hl{color:var(--ink)}
/* the time tile is wider so its little table fits */
.tiles{grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.7fr) minmax(0,1fr)}
.tile .sub{font-size:.82rem;color:var(--muted)}
.tile.shame .big{color:var(--shame)}
.reveal{all:unset;cursor:pointer;display:flex;flex-direction:column;gap:4px;border-radius:4px}
.reveal:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.masked{letter-spacing:.12em;color:var(--muted)}
.hint{font-size:.75rem;color:var(--accent);font-family:var(--mono)}

/* pile */
.pile{display:grid;grid-template-columns:1fr;gap:24px;background:var(--paper);border:1px solid var(--rule);border-radius:10px;padding:24px}
.pile-head{display:flex;flex-direction:column;gap:6px}
.shelfbar{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between}
.seg{display:inline-flex;border:1px solid var(--rule);border-radius:6px;overflow:hidden;font-size:.8rem}
.seg button{background:var(--paper);border:0;padding:5px 12px;font-weight:600;color:var(--muted)}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--bg)}
.seglabel{font-size:.8rem;color:var(--muted);display:inline-flex;gap:8px;align-items:center}
.genrelegend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.8rem;margin-top:10px}
.genrelegend span{display:inline-flex;gap:6px;align-items:center}
.genrelegend i{width:10px;height:14px;border-radius:2px;display:inline-block}
.genrestatus{font-size:.78rem;color:var(--muted);font-family:var(--mono)}
.newnote{font-size:.88rem;display:flex;align-items:center;gap:8px}
.newnote i{width:12px;height:12px;border-radius:2px;outline:2px solid var(--warn);outline-offset:1px;background:var(--cloth-2);display:inline-block}
.spine.new{outline:3px solid var(--warn);outline-offset:1px;position:relative;z-index:1}
.linkbtn{background:none;border:0;padding:0;color:var(--shame);text-decoration:underline;font:inherit;cursor:pointer}
.pill.stalled{color:var(--shame);border-color:var(--shame)}
.pill.new{color:var(--warn);border-color:var(--warn)}
.pile-title{font-size:2rem;color:var(--shame)}
.bookcase{--row:176px;--plank-top:color-mix(in srgb,var(--wood) 70%,#fff2d6);position:relative;background:var(--wood-back);border:0 solid var(--post);border-width:12px 11px 0;border-top-color:var(--wood);border-radius:3px 3px 2px 2px;padding:0 10px;font-size:0;line-height:var(--row);min-height:var(--row);margin-top:14px;
  box-shadow:0 0 0 2px var(--outline),inset 2px 0 0 var(--outline),inset -2px 0 0 var(--outline),inset 0 2px 0 var(--outline);
  background-image:repeating-linear-gradient(to bottom,transparent 0 calc(var(--row) - 17px),var(--outline) calc(var(--row) - 17px) calc(var(--row) - 15px),var(--plank-top) calc(var(--row) - 15px) calc(var(--row) - 10px),var(--outline) calc(var(--row) - 10px) calc(var(--row) - 9px),var(--wood) calc(var(--row) - 9px) calc(var(--row) - 2px),var(--outline) calc(var(--row) - 2px) var(--row)),
    repeating-linear-gradient(to bottom,rgba(0,0,0,.16) 0,transparent 14px,transparent var(--row))}
.spine{--bd:color-mix(in srgb,var(--c) 22%,#f6e0a8);display:inline-flex;align-items:center;justify-content:center;vertical-align:bottom;margin-bottom:12px;height:var(--h);width:var(--w);color:var(--spine-ink);border:1.5px solid var(--outline);border-radius:3px 3px 1px 1px;writing-mode:vertical-rl;text-orientation:mixed;font-size:.68rem;font-family:var(--mono);line-height:1.2;white-space:nowrap;overflow:hidden;padding:22px 0;
  background:linear-gradient(90deg,rgba(255,255,255,.2) 0 3px,transparent 3px calc(100% - 4px),rgba(0,0,0,.24) calc(100% - 4px)),var(--bands,linear-gradient(transparent,transparent)),var(--c);
  box-shadow:3px 0 0 -1px rgba(0,0,0,.14);transform:rotate(var(--r));transform-origin:bottom right}
.spine.s0{--bands:linear-gradient(var(--bd),var(--bd)) 0 8px/100% 4px no-repeat,linear-gradient(var(--bd),var(--bd)) 0 calc(100% - 8px)/100% 4px no-repeat}
.spine.s1{--bands:linear-gradient(var(--bd),var(--bd)) 0 9px/100% 7px no-repeat,linear-gradient(var(--bd),var(--bd)) 0 calc(100% - 9px)/100% 2px no-repeat}
.spine.s2{--bands:linear-gradient(var(--bd),var(--bd)) 0 6px/100% 2px no-repeat,linear-gradient(var(--bd),var(--bd)) 0 11px/100% 2px no-repeat,linear-gradient(var(--bd),var(--bd)) 0 calc(100% - 6px)/100% 2px no-repeat,linear-gradient(var(--bd),var(--bd)) 0 calc(100% - 11px)/100% 2px no-repeat}
.spine.s3{--bands:linear-gradient(rgba(0,0,0,.28),rgba(0,0,0,.28)) 0 0/100% 15px no-repeat,linear-gradient(var(--bd),var(--bd)) 0 15px/100% 2px no-repeat}
.spine.s4{--bands:linear-gradient(#f1e7cf,#f1e7cf) 50% 7px/62% 9px no-repeat}
.spine.g2{--bd:var(--c2);--bands:linear-gradient(var(--bd),var(--bd)) 0 8px/100% 7px no-repeat,linear-gradient(var(--outline),var(--outline)) 0 7px/100% 9px no-repeat,linear-gradient(var(--bd),var(--bd)) 0 calc(100% - 8px)/100% 7px no-repeat,linear-gradient(var(--outline),var(--outline)) 0 calc(100% - 7px)/100% 9px no-repeat}
.spine b{font-weight:inherit;display:block;min-inline-size:0;max-inline-size:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spine.lean{margin-left:12px}
/* Books lying flat in a small pile now and then, spines out */
.lay{display:inline-flex;flex-direction:column;align-items:flex-start;vertical-align:bottom;margin:0 4px 12px 5px;line-height:1.2}
.lay .spine{display:flex;margin:-1.5px 0 0 var(--dx);writing-mode:horizontal-tb;width:var(--len);height:var(--th);padding:0 14px;font-size:.6rem;transform:none;
  background:linear-gradient(rgba(255,255,255,.2) 0 2px,transparent 2px calc(100% - 3px),rgba(0,0,0,.24) calc(100% - 3px)),linear-gradient(90deg,transparent 0 6px,var(--bd) 6px 9px,transparent 9px calc(100% - 9px),var(--bd) calc(100% - 9px) calc(100% - 6px),transparent 0),var(--c)}
.lay .spine.g2{background:linear-gradient(rgba(255,255,255,.2) 0 2px,transparent 2px calc(100% - 3px),rgba(0,0,0,.24) calc(100% - 3px)),linear-gradient(90deg,transparent 0 5px,var(--outline) 5px 6px,var(--c2) 6px 12px,var(--outline) 12px 13px,transparent 13px calc(100% - 13px),var(--outline) calc(100% - 13px) calc(100% - 12px),var(--c2) calc(100% - 12px) calc(100% - 6px),var(--outline) calc(100% - 6px) calc(100% - 5px),transparent 0),var(--c)}
.lay .spine:first-child{margin-top:0}
.gx{display:inline-block;vertical-align:bottom;margin:0 0 12px 14px;line-height:0;cursor:help;--dk-metal:#c99a3e}
.gx-spin{animation:gxspin 9s linear infinite}@keyframes gxspin{from{transform:translateX(0)}to{transform:translateX(-60px)}}
.cb-b,.cb-p{transform-box:fill-box;transform-origin:center;animation:3.2s var(--d) ease-in infinite both}.cb-b{animation-name:cbrise}.cb-p{animation-name:cbpop;opacity:0}
@keyframes cbrise{0%{transform:translateY(0) scale(.4);opacity:0}10%{opacity:1}30%{transform:translate(2px,-12px) scale(.8)}55%{transform:translate(-2px,-26px) scale(1)}80%{transform:translate(1px,-38px) scale(1.05);opacity:1}86%{transform:translate(1px,-38px) scale(1.45);opacity:0}100%{transform:translate(1px,-38px) scale(1.45);opacity:0}}
@keyframes cbpop{0%,80%{opacity:0;transform:scale(.6)}86%{opacity:1;transform:scale(1)}96%{opacity:0;transform:scale(1.35)}100%{opacity:0}}
.cb-fire{transform-origin:30px 90px;animation:dkflick 1.4s ease-in-out infinite alternate}@keyframes dkflick{0%{transform:scale(1,1)}50%{transform:scale(1.06,.92)}100%{transform:scale(.95,1.05)}}
@media (prefers-reduced-motion:reduce){.gx-spin,.cb-b,.cb-p,.cb-fire{animation:none}.cb-p{opacity:0}}
.decor{display:inline-block;vertical-align:bottom;margin-bottom:12px;line-height:0;--dk-metal:#c99a3e;--dk-leaf:#5a9a4e;--dk-leaf2:#3d7a43;--dk-leaf3:#8cbf7a;--dk-pot:#c0663a;--dk-pot2:#ece4d4;--dk-vase:#2f7f86;--dk-bloom:#e8566a;--dk-box:#b5462f;--dk-wax:#efe4c8}
.decor.orn{margin:0 6px 12px}
.decor svg{display:block;width:100%;height:100%;overflow:visible}
:root[data-theme="halloween"] .decor{--dk-metal:#6b5590;--dk-wax:#d9d0ea}
:root[data-theme="cozy"] .decor{--dk-metal:#b08d57}
.more{font-family:var(--mono);font-size:.78rem;color:var(--muted);margin-top:8px;text-align:right}
.pile-empty{padding:40px 0;text-align:center;color:var(--ok);font-weight:600;font-size:.95rem;line-height:1.5}
.pile-facts{display:flex;flex-direction:column;gap:18px;min-width:0}
.meter{height:14px;border-radius:7px;background:var(--rule);overflow:hidden;display:flex}
.meter i{display:block;height:100%}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 18px}
.fact{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--rule);padding-top:8px;min-width:0}
.fact .v{font-family:var(--mono);font-size:1.2rem;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.fact .l{font-size:.8rem;color:var(--muted)}
.verdict{font-size:1.02rem;margin:0;max-width:60ch}
.verdict strong{color:var(--shame)}

/* breakdown */
.grid3{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) minmax(0,1fr);gap:20px}
.card{background:var(--paper);border:1px solid var(--rule);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:14px;min-width:0}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.8rem}
.legend span{display:inline-flex;gap:6px;align-items:center}
.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.files{border-top:1px solid var(--rule);margin-top:14px;padding-top:12px;display:flex;flex-direction:column;gap:6px}
.files h4{margin:0;font-size:.9rem}
.files .note{margin:0}
.statlist{display:flex;flex-direction:column;gap:6px;font-size:.88rem}
/* Sections below the first screen aren't laid out until they're scrolled near, which keeps big libraries quick on phones */
section.shelf,.grid3{content-visibility:auto;contain-intrinsic-size:auto 1200px}
/* This year: a slim strip above the summary, for anyone keeping a yearly book budget. It starts over every January 1. */
.yearstrip{display:grid;grid-template-columns:auto repeat(4,minmax(0,1fr));align-items:center;gap:6px 22px;background:var(--paper);border:1px solid var(--rule);border-radius:10px;padding:10px 18px;margin-bottom:-14px}
.yearstrip h3{margin:0;white-space:nowrap}.yearstrip .ys{display:flex;flex-direction:column;min-width:0;border-left:1px solid var(--rule);padding-left:14px}
.yearstrip .v{font-family:var(--mono);font-size:1.05rem;font-weight:600;font-variant-numeric:tabular-nums}.yearstrip .l{font-size:.76rem;color:var(--muted)}
.yearstrip .reveal{align-self:flex-start}
@media (max-width:640px){.yearstrip{grid-template-columns:repeat(2,minmax(0,1fr))}.yearstrip h3{grid-column:1/-1}.yearstrip .ys{border-left:0;padding-left:0}}
/* By status as a small table: books and pages in their own labeled columns */
.sttab{width:100%;min-width:0;border-collapse:collapse;font-size:.88rem}.sttab th{position:static;background:none}.sttab th{font-family:var(--mono);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);text-align:right;padding:0 0 4px;border-bottom:1px solid var(--rule)}
.sttab th:first-child{text-align:left}.sttab td{padding:5px 0;border-bottom:0;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.sttab td:first-child{text-align:left}
.sttab td .pc{color:var(--muted);font-size:.78rem;margin-left:4px}.sttab tr.tot td{border-top:1px solid var(--rule);font-weight:600}
.sttab i{width:9px;height:9px;border-radius:2px;display:inline-block;margin-right:7px;vertical-align:0}
.stsub{font-family:var(--mono);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:4px 0 -2px;border-top:1px solid var(--rule);padding-top:10px}
.statlist .bk{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic;color:var(--muted);font-size:.82rem}
.statlist .two{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:baseline}
.statlist .num{white-space:nowrap}
.statlist div{display:flex;justify-content:space-between;gap:8px}
.bars{height:170px;min-width:0}
.bars svg{display:block;overflow:visible}
.bars .yn{font-family:var(--mono);font-size:10px;fill:var(--muted)}
.bars .yy{font-family:var(--mono);font-size:10px;fill:var(--muted)}
.bars .ybase{stroke:var(--rule);stroke-width:1}
.bars .ycursor{fill:var(--ink);opacity:.08}
.bars .yhit{cursor:default}
.bar{flex:1 0 26px;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end;min-width:26px}
.bar .col{width:100%;display:flex;flex-direction:column-reverse;border-radius:3px 3px 0 0;overflow:hidden}
.bar .col i{display:flex;align-items:center;justify-content:center;width:100%;font-family:var(--mono);font-style:normal;font-size:.62rem;font-weight:600;color:var(--bg);overflow:hidden;line-height:1}
.bar{cursor:default}
.bar:hover .col,.bar:focus .col{outline:2px solid var(--ink);outline-offset:1px}
.rings{margin-top:14px;border-top:1px solid var(--rule);padding-top:12px}
.rings .rhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px}
.rings .rhead span{font-family:var(--mono);font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.rings .rhead b{font-variant-numeric:tabular-nums;font-size:.9rem}
.rings .rrow{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center}
.rings svg{width:100%;max-width:76px;display:block;margin:0 auto 4px}
.rings .rt{fill:none;stroke-width:7;opacity:.18}
.rings .rv{fill:none;stroke-width:7;stroke-linecap:round;transition:stroke-dasharray .35s ease}
.rings .rp{font-family:var(--mono);font-size:15px;fill:var(--ink);text-anchor:middle;dominant-baseline:central}
.rings .rl{font-size:.8rem;line-height:1.25}
.rings .rn{font-size:.76rem;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){.rings .rv{transition:none}}
.yearinfo{font-size:.84rem;min-height:1.3em;font-variant-numeric:tabular-nums}
.yearinfo b{font-family:var(--mono)}
.bar .n{font-family:var(--mono);font-size:.68rem;color:var(--muted)}
.bar .y{font-family:var(--mono);font-size:.68rem;color:var(--muted)}
.authors{display:flex;flex-direction:column;gap:8px;font-size:.88rem}
.arow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;align-items:center}
.arow .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arow .track{grid-column:1/-1;height:5px;background:var(--rule);border-radius:3px;overflow:hidden;display:flex}

/* table */
.shelf{display:flex;flex-direction:column;gap:14px}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.libtabs{align-self:flex-start;font-size:.86rem}.libtabs button{padding:6px 14px}.libtabs .c{font-family:var(--mono);opacity:.7;margin-left:6px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--rule);background:var(--paper);border-radius:999px;padding:4px 12px;font-size:.82rem}
.chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.chip .c{font-family:var(--mono);opacity:.7;margin-left:4px}
input[type=search],input[type=text],input[type=number],input[type=date],select,textarea{background:var(--paper);border:1px solid var(--rule);border-radius:6px;padding:7px 10px;min-width:0}
#q{width:260px;max-width:100%}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:10px;background:var(--paper)}
table{border-collapse:collapse;width:100%;min-width:760px;font-size:.88rem}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--rule);vertical-align:middle}
th{font-family:var(--mono);font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;white-space:nowrap;background:var(--paper);position:sticky;top:0}
th button{background:none;border:0;padding:0;font:inherit;color:inherit;text-transform:inherit;letter-spacing:inherit}
th button[data-dir]::after{content:" ↓"} th button[data-dir="1"]::after{content:" ↑"}
td.r,th.r{text-align:right}
tbody tr:hover{background:var(--bg)}
.t-title{font-weight:600;cursor:pointer}
.t-title:hover{text-decoration:underline}
.t-author{color:var(--muted);font-size:.82rem}
.t-genre{display:flex;flex-wrap:wrap;align-items:center;gap:3px 5px;margin-top:3px;font-size:.74rem;color:var(--muted)}
.t-genre .gsw{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}.t-genre .gsw i{width:8px;height:8px;border-radius:2px;display:inline-block}
.t-genre .plus{opacity:.7}.t-genre .gsw+.tag,.t-genre .gsw~.tag:first-of-type{margin-left:4px}
.guessed{margin-left:5px;font-size:.66rem;border:1px dashed var(--muted);border-radius:999px;padding:0 6px;color:var(--muted)}
.tag{border:1px solid var(--rule);background:none;color:var(--muted);border-radius:999px;padding:0 7px;font:inherit;font-size:.7rem;line-height:1.5;cursor:pointer;white-space:nowrap}
.tag:hover{border-color:var(--muted);color:var(--ink)}.tag.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
#tagSel{max-width:200px}#tagSel.on{border-color:var(--accent);color:var(--accent)}
.etags{grid-column:1/-1;margin:0;font-size:.8rem;color:var(--muted)}
.pill{font-family:var(--mono);font-size:.7rem;border-radius:4px;padding:1px 6px;border:1px solid var(--rule);color:var(--muted);margin-left:6px;white-space:nowrap}
.st{border-radius:5px;padding:3px 6px;font-size:.8rem;border:1px solid var(--rule)}
.st.unread{color:var(--shame);background:var(--shame-soft);border-color:transparent}
.st.finished{color:var(--ok)}
.prog{display:flex;align-items:center;gap:8px;min-width:110px}
.prog .track{flex:1;height:5px;background:var(--rule);border-radius:3px;overflow:hidden}
.prog .track i{display:block;height:100%;background:var(--accent)}
.stars{color:var(--warn);letter-spacing:1px;white-space:nowrap}
.est{color:var(--muted);font-style:italic}
.showmore{align-self:center}
.empty-shelf{padding:36px;text-align:center;color:var(--muted)}

/* dialogs */
dialog{border:1px solid var(--rule);border-radius:12px;background:var(--paper);color:var(--ink);padding:0;width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 48px)}
dialog::backdrop{background:rgba(10,12,14,.5)}
.dlg{display:flex;flex-direction:column;gap:16px;padding:22px}
.dlg-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
.x{background:none;border:0;font-size:1.4rem;line-height:1;color:var(--muted)}
.tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--rule)}
.tab{background:none;border:0;border-bottom:2px solid transparent;padding:8px 10px;font-size:.88rem;color:var(--muted);font-weight:600}
.tab[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent)}
.steps{margin:0;padding-left:1.3em;display:flex;flex-direction:column;gap:6px;font-size:.9rem}
.code{position:relative;background:var(--bg);border:1px solid var(--rule);border-radius:8px}
.code pre{margin:0;padding:12px;font-family:var(--mono);font-size:.72rem;max-height:130px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.code .btn{position:absolute;top:8px;right:8px}
textarea{width:100%;min-height:110px;font-family:var(--mono);font-size:.78rem;resize:vertical}
.drop{border:1.5px dashed var(--rule);border-radius:8px;padding:14px;text-align:center;font-size:.88rem;color:var(--muted)}
.drop.over{border-color:var(--accent);color:var(--accent)}
.row{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}
.form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.form label{display:flex;flex-direction:column;gap:4px;font-size:.8rem;color:var(--muted);min-width:0}
.form label.full{grid-column:1/-1}
.form label.check{flex-direction:row;align-items:center;font-size:.88rem;color:var(--ink)}
.form input,.form select,.form textarea{color:var(--ink);font-size:.92rem}
.check{display:flex;gap:8px;align-items:center;font-size:.88rem}
.note{font-size:.8rem;color:var(--muted);margin:0}
.dlg-foot{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:center}
.verline{margin:12px 0 0;font-size:.8rem;color:var(--muted);text-align:center}
.result{font-size:.88rem;min-height:1.3em}
.result.err{color:var(--shame)}

#toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:9px 16px;border-radius:8px;font-size:.88rem;opacity:0;pointer-events:none;transition:opacity .2s}
#toast.show{opacity:1}

@media (max-width:900px){.grid3{grid-template-columns:1fr}.pile{grid-template-columns:1fr}}
@media (max-width:640px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.tile.shame{grid-column:1/-1;order:3;border-radius:0!important}.tile.time{grid-column:1/-1;order:4;border-radius:0 0 9px 9px!important}.tile:first-child{border-radius:9px 0 0 0}.tile:nth-child(2){border-radius:0 9px 0 0}.tile:nth-child(3){border-radius:0 0 0 9px}.tile:last-child{border-radius:0 0 9px 0}.tile .big{font-size:1.35rem}h1{font-size:1.35rem}.form{grid-template-columns:1fr}.facts{grid-template-columns:1fr 1fr}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`);


const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ---------- example library (not saved, clearly labelled) ----------
const DEMO = [
  ['Moby-Dick','Herman Melville',635,2.99,'2016-11-02','unread',0,'purchase'],
  ['Middlemarch','George Eliot',880,0,'2017-03-14','unread',0,'free'],
  ['War and Peace','Leo Tolstoy',1296,3.99,'2015-01-20','reading',22,'purchase'],
  ['Pride and Prejudice','Jane Austen',432,0,'2015-06-01','finished',100,'free',5],
  ['Frankenstein','Mary Shelley',280,0.99,'2018-10-29','finished',100,'purchase',4],
  ['The Count of Monte Cristo','Alexandre Dumas',1276,1.99,'2019-08-11','unread',3,'purchase'],
  ['Crime and Punishment','Fyodor Dostoevsky',565,2.49,'2020-02-17','unread',0,'purchase'],
  ['The Brothers Karamazov','Fyodor Dostoevsky',824,2.99,'2021-05-09','unread',0,'purchase'],
  ['Great Expectations','Charles Dickens',505,0,'2020-12-24','finished',100,'free',4],
  ['Bleak House','Charles Dickens',1017,0.99,'2022-01-06','unread',0,'purchase'],
  ['Dracula','Bram Stoker',418,0,'2022-10-15','finished',100,'free',4],
  ['Anna Karenina','Leo Tolstoy',864,2.99,'2023-04-02','abandoned',41,'purchase'],
  ['Jane Eyre','Charlotte Brontë',532,0,'2023-09-19','reading',64,'free'],
  ['The Odyssey','Homer',541,1.99,'2024-07-07','unread',0,'purchase'],
  ['Don Quixote','Miguel de Cervantes',1072,3.49,'2024-12-01','unread',0,'purchase'],
  ['The Picture of Dorian Gray','Oscar Wilde',254,0,'2025-03-30','finished',100,'ku',5],
  ['Ulysses','James Joyce',730,1.99,'2025-08-18','unread',0,'purchase'],
  ['Little Women','Louisa May Alcott',759,0,'2026-02-11','unread',0,'free'],
  ['Walden','Henry David Thoreau',352,0.99,'2026-06-23','unread',0,'purchase'],
  ['Emma','Jane Austen',474,0,'2026-08-30','reading',12,'sample'],
].map((r,i) => ({id:'demo'+i, title:r[0], author:r[1], pages:r[2], price:r[3], date:r[4], status:r[5], progress:r[6], source:r[7], rating:r[8]||0, asin:''}));
// Two example books count as just bought, so the example shows the "bought in the last 5 days" highlight
{ const G = {'Moby-Dick':'fiction','Middlemarch':'fiction','War and Peace':'history','Pride and Prejudice':'romance','Frankenstein':'horror','The Count of Monte Cristo':'mystery','Crime and Punishment':'mystery','The Brothers Karamazov':'mystery','Great Expectations':'fiction','Bleak House':'fiction','Dracula':'horror','Anna Karenina':'romance','Jane Eyre':'romance','The Odyssey':'fantasy','Don Quixote':'humor','The Picture of Dorian Gray':'horror','Ulysses':'fiction','Little Women':'kids','Walden':'nonfiction','Emma':'romance'};
  const T = {'Pride and Prejudice':['Classic Romance','Regency Romance','Humorous Fiction'],'Frankenstein':['Gothic Fiction','Classic Science Fiction'],'Dracula':['Gothic Fiction','Vampire Horror'],
    'The Count of Monte Cristo':['Historical Fiction','Classic Romance','Action & Adventure'],'Crime and Punishment':['Psychological Fiction','Russian Literature'],'The Brothers Karamazov':['Russian Literature','Philosophy'],
    'Bleak House':['Legal Thrillers','Victorian Literature'],'Middlemarch':['Classic Romance','Victorian Literature'],'Jane Eyre':['Gothic Romance','Psychological Suspense'],'The Odyssey':['Ancient Classics','Mythology'],
    'The Picture of Dorian Gray':['Gothic Fiction','Classic Fantasy'],'Little Women':['Coming of Age','Family Saga'],'Anna Karenina':['Classic Romance','Russian Literature'],'Moby-Dick':['Sea Adventures','American Classics'],
    'War and Peace':['Russian Literature','Historical Fiction','War Fiction'],'Walden':['Nature Writing','Philosophy'],'Don Quixote':['Satire','Spanish Literature'],'Ulysses':['Irish Literature','Modernist Fiction'],'Great Expectations':['Coming of Age','Victorian Literature'],'Emma':['Classic Romance','Regency Romance']};
  const G2 = {'Pride and Prejudice':'humor','Frankenstein':'scifi','The Count of Monte Cristo':'romance','Bleak House':'mystery','Middlemarch':'romance','Jane Eyre':'mystery','The Picture of Dorian Gray':'fantasy'}; // what secondGenre() makes of the tags
  DEMO.forEach(b => { b.genre = G[b.title]; b.genreSrc = 'manual'; b.tags = T[b.title] || []; b.genre2 = G2[b.title] || ''; }); }
{ const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0,10); DEMO[17].date = daysAgo(3); DEMO[18].date = daysAgo(1); }

// Earlier versions defaulted to 30 pages a day; move untouched settings to the new Average pace
const migrateSettings = s => (s.pagesPerDay === 30 && !s.paceSet ? {...s, pagesPerDay: 55} : s);
// The finish-date line ends with one of these, taking turns on each visit
const QUIPS = [', or until your next 1-Click purchase', ", assuming the next Kindle Daily Deal doesn't find you", ', give or take your next impulse buy', '… for now. We both know how this goes.'];
const QUIP = (() => {
  let i = Math.floor(Math.random() * QUIPS.length);
  try { const last = +localStorage.getItem('kindle-calc-quip'); if (!isNaN(last) && localStorage.getItem('kindle-calc-quip') !== null) i = (last + 1) % QUIPS.length; localStorage.setItem('kindle-calc-quip', i); } catch {}
  return QUIPS[i];
})();
const PACES = {slow: 35, average: 55, fast: 90};
const DEFAULTS = {defPages:320, defPrice:7.99, minPerPage:1.1, pagesPerDay:55, currency:'USD', doneAt:90, extras:false, borrowed:false, samples:false, grAll:false};
// Phones draw the library table in smaller pages, so the page stays quick with a big library
const PAGE_ROWS = window.matchMedia('(max-width: 640px)').matches ? 40 : 150;
const S = {showMoney:false, books: DEMO.map(b => ({...b})), settings:{...DEFAULTS}, demo:true, mode:'demo', filter:'all', q:'', tag:'', sort:{k:'date', dir:-1}, limit:PAGE_ROWS};

// ---------- persistence ----------
let db = null, col = null, saved = {}, saveTimer = null, savedMeta = '';
const LS = 'kindle-calc-v1';
const lsGet = () => { try { return JSON.parse(GM_getValue(LS, 'null')); } catch { return null; } };
const lsSet = v => { try { GM_setValue(LS, JSON.stringify(v)); return true; } catch { return false; } };

async function initStore() {
  const local = lsGet();
  S.mode = 'local';
  if (local) { S.books = local.books || []; S.settings = migrateSettings({...DEFAULTS, ...(local.settings || {})}); S.demo = false; }
  renderAll();
}

function scheduleSave() {
  if (S.demo) return;
  setStore('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 700);
}
async function persist() {
  saveTimer = null;
  if (S.demo) return;
  if (S.mode === 'db' && col) {
    try {
      const CH = 400, want = {};
      for (let i = 0; i * CH < S.books.length; i++) want['c' + i] = S.books.slice(i * CH, (i + 1) * CH);
      for (const k of Object.keys(want)) {
        const j = JSON.stringify(want[k]);
        if (saved[k] !== j) { await col.doc(k).set({books: want[k]}); saved[k] = j; }
      }
      for (const k of Object.keys(saved)) if (!want[k]) { await col.doc(k).delete(); delete saved[k]; }
      const meta = {settings: S.settings, started: true, count: S.books.length};
      const mj = JSON.stringify(meta);
      if (mj !== savedMeta) { await col.doc('meta').set(meta); savedMeta = mj; }
      setStore();
    } catch (e) {
      console.warn(e);
      if (e?.code === 'invalid_argument') { S.mode = 'local'; col = null; lsSet({books: S.books, settings: S.settings}); setStore(); return; }
      setStore('error', e?.code === 'invalid_argument' ? 'Read-only here: ask the owner for Contributor access' : 'Could not save — changes kept on this page');
    }
  } else {
    const ok = lsSet({books: S.books, settings: S.settings}) && !!lsGet();
    if (ok && typeof driveQueue === 'function') driveQueue(); // and on to Google Drive, if connected
    if (ok) setStore(); else setStore('error', "This browser won't let the page save. Use Back up to keep your books.");
  }
}
// Save immediately if the page is closed or hidden before the short save delay runs
const flushSave = () => { if (saveTimer) { clearTimeout(saveTimer); persist(); } };
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
function setStore(state, msg) {
  const el = $('#store'), sp = el.querySelector('span');
  el.className = 'store ' + (S.demo ? 'st-none' : state === 'saving' ? 'st-wait' : 'st-ok');
  if (S.demo) sp.textContent = 'Example library · not saved';
  else if (state === 'saving') sp.textContent = 'Saving…';
  else if (state === 'error') { sp.textContent = msg; el.className = 'store st-bad'; }
  else sp.textContent = 'Saved in this browser only';
  $('#demoBanner').hidden = !S.demo;
}
function leaveDemo(clear) {
  if (!S.demo) return;
  S.demo = false;
  if (clear) S.books = [];
}

// ---------- helpers ----------
const fmtMoney = v => { try { return new Intl.NumberFormat(undefined, {style:'currency', currency:S.settings.currency, maximumFractionDigits: v >= 1000 ? 0 : 2}).format(v); } catch { return '$' + v.toFixed(2); } };
const fmtInt = v => Math.round(v).toLocaleString();
const fmtHours = h => h < 1 ? Math.round(h * 60) + ' min' : fmtInt(h) + ' h';
const counted = b => {
  if (b.returned) return false;
  if (b.source === 'sample' && !S.settings.samples) return false;
  if (b.source === 'device' && !S.settings.extras) return false;
  if ((b.source === 'ku' || b.source === 'prime' || b.source === 'other' || b.source === 'shared') && !S.settings.borrowed) return false;
  return true;
};
const pagesOf = b => b.pages > 0 ? b.pages : S.settings.defPages;
const hasPaid = b => b.price != null && b.price !== '';
// Value: what you paid, else today's Kindle price, else the default guess (bought books only)
const valueOf = b => b.source === 'free' || b.source === 'device' ? 0 : hasPaid(b) ? +b.price : b.kp != null ? b.kp : b.source === 'purchase' ? S.settings.defPrice : 0;
const hoursFor = p => p * S.settings.minPerPage / 60;
const remainingPages = b => b.status === 'unread' ? pagesOf(b) : b.status === 'reading' ? pagesOf(b) * (1 - (b.progress || 0) / 100) : 0;
const recentCutoff = () => new Date(Date.now() - 5 * 864e5).toISOString().slice(0,10);
const isNew = b => !!b.date && b.date >= recentCutoff();
// Books marked Reading for more than a year get flagged for a decision: finish it, or call it DNF
const YEAR_MS = 365 * 864e5;
const isStalled = b => b.status === 'reading' && !!b.readingSince && Date.now() - new Date(b.readingSince).getTime() > YEAR_MS;
function trackReading() { // remember when each book became "Reading"; existing ones count from their purchase date
  const today = new Date().toISOString().slice(0, 10);
  for (const b of S.books) {
    if (b.status === 'reading' && !b.readingSince) b.readingSince = b.date && b.date < today ? b.date : today;
    else if (b.status !== 'reading' && b.readingSince) delete b.readingSince;
  }
}
const STATUS = {unread:'Unread', reading:'Reading', finished:'Finished', abandoned:'DNF'};
const STATUS_COLOR = {finished:'var(--ok)', reading:'var(--accent)', unread:'var(--shame)', abandoned:'var(--muted)'};
const SOURCE = {purchase:'', device:'came with Kindle', free:'free', ku:'KU', prime:'Prime', sample:'sample', other:'borrowed', shared:'shared'};
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const yearsAgo = d => { const ms = Date.now() - new Date(d).getTime(); return ms / 3.156e10; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function statusFromProgress(p) {
  if (p == null || isNaN(p)) return null;
  if (p >= S.settings.doneAt) return 'finished';
  if (p > 0) return 'reading';
  return 'unread';
}

// ---------- rendering ----------
// ---------- genres ----------
// The genre is Amazon's own: the main category in the book's Kindle Store trail ("Kindle eBooks › Romance › Paranormal").
// The most common ones get their own spine color; everything else is "Other" but keeps its real name.
const GENRES = {romance:'Romance', fantasy:'Fantasy', scifi:'Science Fiction', mystery:'Mystery, Thriller & Suspense', horror:'Horror', erotica:'Erotica', fiction:'Literature & Fiction', kids:'Teen & Young Adult', comics:'Comics, Manga & Graphic Novels', humor:'Humor & Entertainment', cooking:'Cookbooks, Food & Wine', selfhelp:'Self-Help', history:'History', nonfiction:'Other', unknown:'Unknown'};
const GENRE_KEY = {...Object.fromEntries(Object.entries(GENRES).filter(([k]) => k !== 'nonfiction' && k !== 'unknown').map(([k, v]) => [v.toLowerCase(), k])), 'science fiction & fantasy': 'scifi'};
const cleanCat = s => String(s || '').replace(/\s*Customer Reviews.*$/i, '').replace(/\s+eBooks$/i, '').trim();
// inf: {trail:[...crumbs], best:[...best-seller lists]} from the sync script (older scripts send cats: [crumb text, ...lists])
function amazonGenre(inf) {
  let trail = inf.trail, best = inf.best;
  if (!trail && inf.cats) { const c0 = inf.cats[0] || ''; trail = c0.includes('›') ? c0.split('›').map(x => x.trim()) : []; best = c0.includes('›') ? inf.cats.slice(1) : inf.cats; }
  trail = (trail || []).map(x => String(x || '').trim()).filter(Boolean); best = (best || []).map(cleanCat).filter(x => x && !/^kindle store$/i.test(x));
  const root = trail.findIndex(x => /^kindle ebooks$|^ebooks$|^books$/i.test(x));
  const path = root >= 0 ? trail.slice(root + 1) : trail.filter(x => !/^kindle store$/i.test(x));
  const sub = best[0] || (path.length > 1 ? path[path.length - 1] : '');
  let name = path[0] || '';
  // "Literature & Fiction" is Amazon's catch-all: when the trail names a more specific genre further down, use that one
  if (/^literature & fiction$/i.test(name)) { const more = path.slice(1).find(x => GENRE_KEY[x.toLowerCase()] && !/^literature & fiction$/i.test(x)); if (more) name = more; }
  // Best-seller lists, read when the trail is missing or only says the catch-all (romance first, so "Paranormal Romance" is romance)
  const fromLists = () => {
    const c = best.join(' | ').toLowerCase(); if (!c) return null;
    const rules = [['erotica', /erotica/], ['romance', /romance|romantic/], ['comics', /comics|graphic novel|manga/], ['kids', /young adult|\bteen/], ['cooking', /cooking|cookbook|recipes|baking/],
      ['horror', /horror/], ['fantasy', /fantasy|sword & sorcery|dragons?|fae|witch|wizard/], ['scifi', /science fiction|sci-fi|space opera|dystopian|cyberpunk|alien/], ['mystery', /mystery|thriller|suspense|crime|detective/], ['humor', /humor|comed/], ['selfhelp', /self-help/], ['history', /\bhistory\b/], ['fiction', /fiction|literature/]];
    const hit = rules.find(([, re]) => re.test(c));
    return hit ? {key: hit[0], name: GENRES[hit[0]], sub} : {key: 'nonfiction', name: best[0], sub};
  };
  if (!name) return fromLists();
  if (/^literature & fiction$/i.test(name)) { const l = fromLists(); if (l && l.key !== 'fiction' && l.key !== 'nonfiction') return l; }
  const key = GENRE_KEY[name.toLowerCase()] || 'nonfiction';
  // Amazon files both under "Science Fiction & Fantasy"; the next step of the trail says which one (else the best-seller lists do)
  if (key === 'scifi') {
    const next = path[1] || '', lists = best.join(' | ');
    const fan = /fantasy/i.test(next) || (!/science fiction/i.test(next) && /fantasy|sword & sorcery|dragon|\bfae\b|witch|wizard|magic/i.test(lists) && !/science fiction|space opera|cyberpunk|alien/i.test(lists));
    return fan ? {key: 'fantasy', name: 'Fantasy', sub} : {key: 'scifi', name: 'Science Fiction', sub};
  }
  return {key, name, sub};
}
const genreLabel = b => b.genre === 'nonfiction' && b.genreName ? b.genreName : GENRES[b.genre] || '';
// Tags: every category Amazon lists the book under (best-seller lists first, then the deeper steps of its trail), minus catch-alls
const TAG_SKIP = /^(literature & fiction|fiction|genre fiction|kindle ebooks|ebooks|books|kindle store|science fiction & fantasy|teen & young adult|.*short reads.*|kindle unlimited.*|.*\bebooks?\b.*)$/i;
function amazonTags(inf) {
  let trail = inf.trail, best = inf.best;
  if (!trail && inf.cats) { const c0 = inf.cats[0] || ''; trail = c0.includes('›') ? c0.split('›').map(x => x.trim()) : []; best = c0.includes('›') ? inf.cats.slice(1) : inf.cats; }
  trail = (trail || []).map(x => String(x || '').trim()).filter(Boolean); best = (best || []).map(cleanCat).filter(Boolean);
  const root = trail.findIndex(x => /^kindle ebooks$|^ebooks$|^books$/i.test(x));
  const path = root >= 0 ? trail.slice(root + 1) : trail.filter(x => !/^kindle store$/i.test(x));
  const seen = new Set(), out = [];
  for (const t of [...best, ...path]) { const k = t.toLowerCase(); if (!TAG_SKIP.test(t) && t.length <= 48 && !seen.has(k)) { seen.add(k); out.push(t); } }
  return out.slice(0, 8);
}
// Second genre: the first tag that points at a different colored genre (a Fantasy book listed under "Fantasy Romance" gets Romance)
const GENRE2_RULES = [['romance', /romance|romantic/], ['fantasy', /fantasy|sword & sorcery|dragons?|\bfae\b|witch|wizard/], ['scifi', /science fiction|sci-fi|space opera|dystopian|cyberpunk|alien/], ['mystery', /mystery|thriller|suspense|crime|detective/], ['horror', /horror/], ['erotica', /erotica/], ['comics', /comics|graphic novel|manga/], ['kids', /young adult|\bteen/], ['humor', /humor|comed/], ['history', /\bhistory\b/], ['cooking', /cooking|cookbook|recipes|baking/], ['selfhelp', /self-help/]];
function secondGenre(tags, main) {
  for (const t of tags || []) { if (/^science fiction & fantasy$/i.test(t)) continue; const lc = t.toLowerCase(), hit = GENRE2_RULES.find(([k, re]) => k !== main && re.test(lc)); if (hit) return hit[0]; }
  return '';
}
const tagsShown = b => { const skip = new Set([genreLabel(b), GENRES[b.genre2] || ''].map(x => x.toLowerCase())); return (b.tags || []).filter(t => !skip.has(t.toLowerCase())); };
const genreLine = b => genreLabel(b) + (b.genre2 && GENRES[b.genre2] ? ' + ' + GENRES[b.genre2] : '') + (b.genreSrc === 'guess' ? ' (guessed from the title)' : '');
// When Amazon has no store page for a book (free and promo books are often taken off sale), guess the genre from its title.
// Marked as a guess; a real genre from Amazon or one you pick replaces it.
const TITLE_GUESS = [
  ['cooking', /\b(recipes?|cook ?books?|cooking|cook|soups?|stews?|desserts?|bak(e|ing|er)|cocktails?|smoothies?|juic(e|ing)|ice creams?|chocolates?|cocoa|vegan|vegetarian|pizzas?|breads?|grill(ing)?|bbq|barbecue|slow cooker|crock ?pot|instant pot|air fryer|keto|paleo|appetizers?|meals?|salads?|sauces?|home ?brew(ing)?|beers?|wines?|candy|fudge|cupcakes?|cookies?|kitchen|dinners?|breakfasts?|brunch|sandwich(es)?|snacks?|drinks?|jerky|casseroles?|muffins?|pies?|pasta|noodles?|chili|curry|sushi|tacos?)\b/],
  ['kids', /\b(children'?s|childrens|kids?|bedtime|good ?night|toddlers?|picture book|preschool|nursery|baby|for children)\b/],
  ['humor', /\b(jokes?|funny|laugh(s|ing)?|humou?r|hilarious|puns?|riddles?|trivia|quotes|puzzles?|puzzlebook)\b/],
  ['horror', /\b(haunted|ghosts?|horror|zombies?|vampires?|creepy|paranormal)\b/],
  ['history', /\b(history|historical|civil war|world war|ww ?(1|2|ii)|ancient|presidents?)\b/],
  ['selfhelp', /\b(self[- ]help|habits?|productivity|mindset|motivation(al)?|happiness|confidence|declutter(ing)?|minimalism|budget(ing)?|saving money)\b/],
  ['mystery', /\b(murders?|mystery|mysteries|detective|thriller|whodunit)\b/],
  ['fantasy', /\b(dragons?|wizards?|witch(es)?|sorcer(er|y)|fae|elves|magic(al)?)\b/],
  ['scifi', /\b(galaxy|galactic|starship|robots?|aliens?|space ?ship|cyborgs?|time travel)\b/],
  ['romance', /\b(romance|romantic|billionaire|bride|wedding|lovers?)\b/],
];
const guessGenre = title => { const t = String(title || '').toLowerCase(); const hit = TITLE_GUESS.find(([, re]) => re.test(t)); return hit ? hit[0] : ''; };
function fillGuesses() {
  if (S.demo) return;
  for (const b of S.books) {
    if (b.genreSrc === 'manual' || (b.genre && b.genre !== 'unknown' && b.genreSrc !== 'guess')) continue;
    const g = guessGenre(b.title);
    if (g) { b.genre = g; b.genreName = GENRES[g]; b.genreSrc = 'guess'; b.genreSub = ''; }
    else if (b.genreSrc === 'guess') { b.genre = ''; b.genreSrc = ''; }
  }
}
// Version 4 adds tags and second genres, so every book gets one more look at its Amazon page (hand-set genres stay as they are)
const GENRE_V = 4, needsGenre = b => !b.genreV || b.genreV < GENRE_V;
function genreStatus(msg) { const el = $('#genreStatus'); el.hidden = !msg; el.textContent = msg || ''; }
// Genres, page counts and today's prices all come from one look at each book's Amazon page (needs the sync script)
function lookupGenres() {
  if (typeof lookupBookInfo === 'function') { lookupBookInfo(); return; }
  const missing = S.books.filter(b => !b.genre).length;
  genreStatus(S.settings.spineMode === 'genre' && missing && !S.demo ? `${missing} books have no genre yet. Genres come from Amazon through the sync script, or click a book's title to set one.` : '');
}
function setSpineMode(m) {
  S.settings.spineMode = m;
  $('#spDefault').setAttribute('aria-pressed', m !== 'genre'); $('#spGenre').setAttribute('aria-pressed', m === 'genre');
  if (m !== 'genre') genreStatus('');
  renderStats(); scheduleSave(); lookupGenres();
}
$('#spDefault').onclick = () => setSpineMode('default');
$('#spGenre').onclick = () => setSpineMode('genre');

document.querySelectorAll('[data-pace]').forEach(b => b.onclick = () => {
  S.settings.pagesPerDay = PACES[b.dataset.pace]; S.settings.paceSet = true;
  renderStats(); scheduleSave();
});
(() => { // the heads-up note stays dismissed in this browser
  const KEY = 'kindle-calc-notice-dismissed';
  try { if (localStorage.getItem(KEY)) $('#notice').hidden = true; } catch {}
  $('#noticeClose').onclick = () => { $('#notice').hidden = true; try { localStorage.setItem(KEY, '1'); } catch {} };
})();
// Only redraw when the width really changes: phones fire resize whenever the address bar slides in or out while scrolling
let resizeT, lastW = window.innerWidth; window.addEventListener('resize', () => { if (window.innerWidth === lastW) return; lastW = window.innerWidth; clearTimeout(resizeT); resizeT = setTimeout(() => { renderStats(); decorShelf(); }, 150); });
// ---------- shelf decorations: whatever space is left on the last shelf gets a bookend and a few knick-knacks ----------
// Items are added one by one until the space runs out, so a wider gap gets more of them and a nearly full shelf gets none.
// Drawn like the books: flat colors with an ink outline. Sizes are [width, height, svg]; leaves may hang over the shelf's front edge.
const OL = 'stroke="var(--outline)" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"';
const leaf = (x, y, r, sc, c) => `<g transform="translate(${x} ${y}) rotate(${r}) scale(${sc})"><path d="M0 0C9-6 9-23 0-32C-9-23-9-6 0 0Z" fill="${c}" ${OL}/><path d="M0-4V-26" stroke="var(--outline)" stroke-opacity=".4" stroke-width="1.1" fill="none" vector-effect="non-scaling-stroke"/></g>`;
const potLight = 'color-mix(in srgb,var(--dk-pot) 78%,#fff)';
const DECOR = {
  bookend: [18, 98, `<svg viewBox="0 0 18 98"><path d="M-13 90h29v8h-29z" fill="var(--post)" ${OL}/><path d="M8 2h8v96H8z" fill="var(--post)" ${OL}/><path d="M10 5h2v84h-2z" fill="rgba(255,255,255,.22)"/></svg>`],
  plant: [74, 122, `<svg viewBox="0 0 74 122"><path d="M17 83C6 92 4 110 9 132" stroke="var(--dk-leaf2)" stroke-width="2.4" fill="none"/>${leaf(8, 101, 205, .42, 'var(--dk-leaf)')}${leaf(7, 117, 160, .4, 'var(--dk-leaf2)')}${leaf(9, 131, 195, .36, 'var(--dk-leaf)')}
    ${leaf(37, 82, -62, .95, 'var(--dk-leaf2)')}${leaf(37, 82, 62, .95, 'var(--dk-leaf2)')}${leaf(37, 82, -32, 1.1, 'var(--dk-leaf)')}${leaf(37, 82, 30, 1.1, 'var(--dk-leaf)')}${leaf(37, 82, -8, 1.3, 'var(--dk-leaf2)')}${leaf(37, 82, 12, 1.05, 'var(--dk-leaf)')}
    <path d="M18 87h38l-4 35H22z" fill="var(--dk-pot)"/><path d="M45 87h11l-4 35h-9z" fill="rgba(0,0,0,.16)"/><path d="M18 87h38l-4 35H22z" fill="none" ${OL}/><rect x="14" y="79" width="46" height="10" rx="2" fill="${potLight}" ${OL}/></svg>`],
  succulent: [50, 62, `<svg viewBox="0 0 50 62">${leaf(25, 36, -78, .5, 'var(--dk-leaf3)')}${leaf(25, 36, 78, .5, 'var(--dk-leaf3)')}${leaf(25, 36, -42, .58, 'var(--dk-leaf)')}${leaf(25, 36, 42, .58, 'var(--dk-leaf)')}${leaf(25, 36, 0, .66, 'var(--dk-leaf3)')}
    <path d="M10 38h30l-4 24H14z" fill="var(--dk-pot2)" ${OL}/><path d="M32 38h8l-4 24h-6z" fill="rgba(0,0,0,.1)"/><rect x="7" y="33" width="36" height="7" rx="2" fill="var(--dk-pot2)" ${OL}/></svg>`],
  vase: [38, 108, `<svg viewBox="0 0 38 108"><path d="M19 62C18 46 21 34 18 18" stroke="#4f8a43" stroke-width="2.6" fill="none" stroke-linecap="round"/>${leaf(19, 46, 52, .42, 'var(--dk-leaf)')}<g transform="translate(18 16)">${[0, 72, 144, 216, 288].map(a => `<ellipse cx="0" cy="-7" rx="4.6" ry="7" transform="rotate(${a})" fill="var(--dk-bloom)" ${OL}/>`).join('')}<circle r="3.8" fill="#f2c14e" ${OL}/></g>
    <g transform="translate(0 38)"><rect x="13" y="22" width="12" height="18" fill="var(--dk-vase)" ${OL}/><circle cx="19" cy="51" r="17" fill="var(--dk-vase)" ${OL}/><path d="M27 37a17 17 0 0 1 0 28" stroke="rgba(0,0,0,.2)" stroke-width="5" fill="none"/><path d="M8 47a12 12 0 0 1 7-9" stroke="rgba(255,255,255,.45)" stroke-width="3" stroke-linecap="round" fill="none"/><rect x="10" y="17" width="18" height="6" rx="2" fill="var(--dk-vase)" ${OL}/></g></svg>`],
  box: [40, 34, `<svg viewBox="0 0 40 34"><rect x="4" y="13" width="32" height="21" rx="2" fill="var(--dk-box)" ${OL}/><rect x="2" y="7" width="36" height="8" rx="2" fill="color-mix(in srgb,var(--dk-box) 75%,#fff)" ${OL}/><circle cx="20" cy="5" r="2.8" fill="var(--dk-metal)" ${OL}/><path d="M17 20h6v6h-6z" fill="var(--dk-metal)" ${OL}/></svg>`],
  stack: [96, 54, `<svg viewBox="0 0 96 54"><rect x="4" y="38" width="88" height="16" rx="2" fill="var(--cloth-2)" ${OL}/><rect x="8" y="22" width="78" height="16" rx="2" fill="var(--cloth-1)" ${OL}/><rect x="2" y="6" width="84" height="16" rx="2" fill="var(--cloth-6)" ${OL}/>
    <g fill="#f3e8cc" ${OL}><rect x="84" y="40" width="5" height="12"/><rect x="78" y="24" width="5" height="12"/><rect x="78" y="8" width="5" height="12"/></g><g fill="color-mix(in srgb,#f4dca0 70%,transparent)"><rect x="12" y="9" width="3" height="10"/><rect x="18" y="25" width="3" height="10"/><rect x="14" y="41" width="3" height="10"/><rect x="64" y="9" width="3" height="10"/><rect x="68" y="41" width="3" height="10"/></g></svg>`],
  pumpkin: [66, 60, `<svg viewBox="0 0 66 60"><path d="M33 13c1-6 4-9 8-10" stroke="#3f6b1f" stroke-width="4.5" fill="none" stroke-linecap="round"/><ellipse cx="18" cy="39" rx="15" ry="20" fill="#e2701c" ${OL}/><ellipse cx="48" cy="39" rx="15" ry="20" fill="#e2701c" ${OL}/><ellipse cx="33" cy="38" rx="15" ry="21" fill="#f58a2a" ${OL}/><path d="M26 22c-3 10-3 22 0 34M40 22c3 10 3 22 0 34" stroke="rgba(120,50,0,.4)" stroke-width="1.5" fill="none"/><path d="M24 30a10 6 0 0 1 8-6" stroke="rgba(255,255,255,.4)" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>`],
  potion: [44, 80, `<svg viewBox="-2 0 44 80"><rect x="15" y="2" width="10" height="9" rx="2" fill="#8a5a36" ${OL}/><path d="M15 10h10v14c9 4 13 11 13 22a18 18 0 0 1-36 0c0-11 4-18 13-22z" fill="rgba(220,210,255,.18)" ${OL}/><path d="M4 46a16 16 0 0 0 32 0c0-3-1-6-2-8H6c-1 2-2 5-2 8z" fill="#9be35a"/><circle cx="14" cy="50" r="2.5" fill="rgba(255,255,255,.5)"/><circle cx="22" cy="44" r="1.6" fill="rgba(255,255,255,.5)"/><path d="M-1 60h42v6H-1z" fill="#6e4a2e" ${OL}/><path d="M1 66h5v14H1zM34 66h5v14h-5z" fill="#5a3b24" ${OL}/><path d="M-2 76h44v4H-2z" fill="#6e4a2e" ${OL}/></svg>`],
};
// Genre globe (phone shelf): a spinning globe whose lands are the small genres' colors
function globeSvg(gs) {
  const c = i => `var(--g-${gs[i % gs.length]})`;
  const lands = [[6, 20, 'M0 0c6-5 15-4 18 2s-2 12-9 11-12-6-9-13z'], [30, 12, 'M0 0c5-3 12-1 12 5s-6 9-11 6-5-7-1-11z'], [22, 34, 'M0 0c7-2 14 3 12 9s-11 6-14 1 0-8 2-10z'], [46, 28, 'M0 0c4-4 11-3 12 3s-5 8-9 6-6-5-3-9z'], [8, 40, 'M0 0c3-2 8 0 7 4s-6 4-8 1 0-4 1-5z']];
  const set = lands.map(([x, y, d], i) => `<path transform="translate(${x} ${y})" d="${d}" fill="${c(i)}" stroke="var(--outline)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('');
  return `<svg viewBox="0 0 60 92" width="60" height="92" aria-hidden="true"><defs><clipPath id="gxClip"><circle cx="30" cy="34" r="24"/></clipPath></defs>
    <path d="M30 60v18" stroke="var(--dk-metal)" stroke-width="4"/><path d="M14 90h32l-4-10H18z" fill="var(--dk-metal)" stroke="var(--outline)" stroke-width="1.6"/>
    <circle cx="30" cy="34" r="24" fill="#5aa9d6" stroke="var(--outline)" stroke-width="1.6"/>
    <g clip-path="url(#gxClip)"><g class="gx-spin"><g transform="translate(6 0)">${set}</g><g transform="translate(66 0)">${set}</g></g>
      <path d="M12 26a24 24 0 0 0 0 16" stroke="rgba(255,255,255,.35)" stroke-width="3" fill="none"/></g>
    <circle cx="30" cy="34" r="24" fill="none" stroke="var(--outline)" stroke-width="1.6"/>
    <path d="M30 6a28 28 0 0 1 0 56" stroke="var(--dk-metal)" stroke-width="3" fill="none"/><circle cx="30" cy="6" r="2" fill="var(--dk-metal)"/><circle cx="30" cy="62" r="2" fill="var(--dk-metal)"/></svg>`;
}
// Halloween: a little cauldron instead, its bubbles in the genres' colors, rising and popping
function cauldronSvg(gs) {
  const bubbles = [[24, 0, 4.5], [34, 0.8, 3.5], [29, 1.6, 5], [38, 2.3, 3], [21, 3.0, 3.8]].map(([x, d, r], i) =>
    `<g class="cb" style="--d:${d}s"><circle class="cb-b" cx="${x}" cy="44" r="${r}" fill="var(--g-${gs[i % gs.length]})" stroke="var(--outline)" stroke-width="1" vector-effect="non-scaling-stroke"/><path class="cb-p" d="M${x} ${44 - 38 - r - 3}v-3M${x - r - 3} ${44 - 38}h-3M${x + r + 3} ${44 - 38}h3M${x - r - 1} ${44 - 38 - r - 1}l-2-2M${x + r + 1} ${44 - 38 - r - 1}l2-2" stroke="var(--g-${gs[i % gs.length]})" stroke-width="1.8" stroke-linecap="round"/></g>`).join('');
  return `<svg viewBox="0 0 60 92" width="60" height="92" aria-hidden="true" overflow="visible">${bubbles}
    <path d="M14 86l-4 6M46 86l4 6" stroke="var(--outline)" stroke-width="3" stroke-linecap="round"/>
    <path class="cb-fire" d="M20 90c-2-6 3-8 2-13 4 3 5 6 4 9 2-3 2-6 1-9 5 4 7 9 5 13z" fill="#ff8c2e" stroke="var(--outline)" stroke-width="1.2"/>
    <ellipse cx="30" cy="66" rx="24" ry="20" fill="#26212e" stroke="var(--outline)" stroke-width="1.6"/>
    <path d="M16 60a16 14 0 0 1 8-10" stroke="rgba(255,255,255,.18)" stroke-width="3" fill="none" stroke-linecap="round"/>
    <ellipse cx="30" cy="48" rx="22" ry="5" fill="#6a3592" stroke="var(--outline)" stroke-width="1.6"/>
    <ellipse cx="30" cy="46" rx="25" ry="5.5" fill="none" stroke="#3a3346" stroke-width="4"/><ellipse cx="30" cy="46" rx="25" ry="5.5" fill="none" stroke="var(--outline)" stroke-width="1.2"/></svg>`;
}
const smallGenreSvg = gs => document.documentElement.dataset.theme === 'halloween' ? cauldronSvg(gs) : globeSvg(gs);
// Comic (phone shelf): lying flat, its cover panels in the tiny genres' colors
function comicSvg(gs) {
  const n = Math.min(gs.length, 4), w = 52 / n;
  const panels = Array.from({length: n}, (_, i) => `<path d="M${10 + i * w} 2h${w - 2}l-6 12h${-(w - 2)}z" fill="var(--g-${gs[i]})" stroke="var(--outline)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('');
  return `<svg viewBox="0 0 70 22" width="70" height="22" aria-hidden="true"><path d="M8 0h60l-8 16H0z" fill="#f4ecd8" stroke="var(--outline)" stroke-width="1.6"/>${panels}
    <path d="M0 16h60v5H0z" fill="#e8dcc0" stroke="var(--outline)" stroke-width="1.6"/><path d="M60 16l8-16v5l-8 16z" fill="#d9cba8" stroke="var(--outline)" stroke-width="1.6"/></svg>`;
}
// The last shelf's leftover space gets a bookend and these, in order; ORNAMENTS are the small things set between books now and then (Default spine colors only)
const DECOR_SETS = {halloween: ['pumpkin', 'potion', 'pumpkin', 'potion', 'pumpkin'], cozy: ['stack', 'plant', 'vase', 'succulent', 'box', 'plant'], default: ['plant', 'stack', 'vase', 'succulent', 'box', 'plant']};
const ORNAMENTS = {halloween: ['pumpkin', 'potion'], cozy: ['succulent', 'vase', 'box', 'stack'], default: ['succulent', 'vase', 'box', 'stack']};
let shelfMemo = {};
// A share as a whole percent, except near the ends: 3 books read out of 659 is 99.5% unread, never a rounded-up 100%
const pctText = p => (p > 0 && p < 1 ? Math.max(.1, Math.round(p * 10) / 10) : p > 99 && p < 100 ? Math.min(99.9, Math.floor(p * 10) / 10) : Math.round(p)) + '%';
const DECOR_ROOM = 340; // px kept free at the end of a computer's full bookcase for the bookend and decorations
function decorShelf() {
  const bc = document.querySelector('#stack .bookcase'); if (!bc) return;
  bc.querySelectorAll('.decor:not(.orn)').forEach(n => n.remove());
  const oset = ORNAMENTS[document.documentElement.dataset.theme] || ORNAMENTS.default; // a theme change swaps the ornaments too
  bc.querySelectorAll('.gx-globe').forEach(n => { n.innerHTML = smallGenreSvg(n.dataset.g.split(' ')); }); // and the globe ↔ cauldron
  bc.querySelectorAll('.orn').forEach((n, j) => { const k = oset[j % oset.length]; n.style.width = DECOR[k][0] + 'px'; n.style.height = DECOR[k][1] + 'px'; n.innerHTML = DECOR[k][2]; });
  // The genre globe/cauldron and the comic stand to the right of the bookend, so take them out while measuring
  const gxs = [...bc.querySelectorAll(':scope > .gx')]; gxs.forEach(n => n.remove());
  const gxW = gxs.reduce((a, n) => a + (n.classList.contains('gx-globe') ? 60 : 70) + 14, 0);
  const spines = bc.querySelectorAll(':scope > .spine, :scope > .lay, :scope > .orn'); if (!spines.length) { gxs.forEach(n => bc.appendChild(n)); return; }
  const last = spines[spines.length - 1].getBoundingClientRect(), box = bc.getBoundingClientRect();
  const free = Math.floor(box.right - 20 - last.right - 4) - gxW; // 10px frame + 10px padding on the right
  const bookend = `<span class="decor" aria-hidden="true" style="width:${DECOR.bookend[0]}px;height:${DECOR.bookend[1]}px">${DECOR.bookend[2]}</span>`;
  if (free < DECOR.bookend[0] + 4) { if (gxs.length) { bc.insertAdjacentHTML('beforeend', bookend); gxs.forEach(n => bc.appendChild(n)); } return; }
  const t = document.documentElement.dataset.theme, set = DECOR_SETS[t] || DECOR_SETS.default;
  const picks = []; let used = DECOR.bookend[0] + 4;
  for (let i = 0; i < 12; i++) { const k = set[i % set.length], w = DECOR[k][0]; if (used + w + 22 > free) break; picks.push(k); used += w + 22; }
  const extra = picks.length ? Math.max(0, free - used) / picks.length : 0; // spread whatever is left between the items
  bc.insertAdjacentHTML('beforeend', bookend);
  gxs.forEach(n => bc.appendChild(n));
  bc.insertAdjacentHTML('beforeend', picks.map(k => `<span class="decor" aria-hidden="true" style="width:${DECOR[k][0]}px;height:${DECOR[k][1]}px;margin-left:${Math.floor(22 + extra)}px">${DECOR[k][2]}</span>`).join(''));
}

function renderAll() { fixEntities(); if (S.settings.theme && typeof applyTheme === 'function') { applyTheme(S.settings.theme); try { localStorage.setItem('klc-theme-picked', '1'); } catch {} } trackReading(); fillGuesses(); setStore(); $('#spDefault').setAttribute('aria-pressed', S.settings.spineMode !== 'genre'); $('#spGenre').setAttribute('aria-pressed', S.settings.spineMode === 'genre'); renderStats(); renderShelf(); setTimeout(lookupGenres, 0); }

function renderStats() {
  const bs = S.books.filter(counted);
  const n = bs.length;
  const by = {unread:[], reading:[], finished:[], abandoned:[]};
  bs.forEach(b => (by[b.status] || by.unread).push(b));
  const value = bs.reduce((a,b) => a + valueOf(b), 0);
  const estPrice = bs.filter(b => b.source === 'purchase' && !hasPaid(b) && b.kp == null).length;
  const nowPrice = bs.filter(b => b.source !== 'free' && !hasPaid(b) && b.kp != null).length;
  const estPages = bs.filter(b => !(b.pages > 0)).length;
  const allPages = bs.reduce((a,b) => a + pagesOf(b), 0);
  const leftPages = bs.reduce((a,b) => a + remainingPages(b), 0);
  const pile = by.unread;
  const pilePages = pile.reduce((a,b) => a + pagesOf(b), 0);
  const pileValue = pile.reduce((a,b) => a + valueOf(b), 0);
  const pct = n ? pile.length / n * 100 : 0;

  $('#tBooks').textContent = fmtInt(n);
  const hidden = S.books.length - n;
  const why = {returned:['returned to Amazon (or no longer in your Amazon library)', 'returned to Amazon (or no longer in your Amazon library)'], shared:['shared with you (Family Library)'], ku:['Kindle Unlimited'], prime:['Prime Reading'], other:['borrowed or library loan', 'borrowed or library loans'], sample:['sample', 'samples'], device:['dictionary or user guide that came with your Kindle', 'dictionaries and user guides that came with your Kindle']};
  const nc = {}; S.books.forEach(b => { if (!counted(b)) { const k = b.returned ? 'returned' : b.source; nc[k] = (nc[k] || 0) + 1; } });
  const tip = `<span class="tipbox" role="tooltip"><strong>Not counted</strong> means books you didn't buy yourself. They stay in your library but are left out of the totals, value, charts and Shelf of Shame:<ul>${Object.keys(why).filter(k => nc[k]).map(k => `<li>${nc[k]} ${why[k][nc[k] === 1 ? 0 : why[k].length - 1]}</li>`).join('')}</ul>See them with the <strong>Not counted</strong> button under Your library. To include them, turn them on in <strong>Settings</strong>, or click a book and change <strong>How you got it</strong>.</span>`;
  $('#tBooksSub').innerHTML = `${fmtInt(by.finished.length)} finished` + (hidden ? ` · <span class="tip" tabindex="0">${hidden} not counted${tip}</span>` : '');
  const mask = v => S.showMoney ? fmtMoney(v) : '••••••';
  $('#tValue').textContent = mask(value);
  $('#tValue').classList.toggle('masked', !S.showMoney);
  // Where the value comes from, so nobody has to guess what "guessed" means
  const vg = {paid:[0,0], now:[0,0], guess:[0,0], zero:[0,0]};
  bs.forEach(b => { const k = b.source === 'free' || b.source === 'device' ? 'zero' : hasPaid(b) ? 'paid' : b.kp != null ? 'now' : b.source === 'purchase' ? 'guess' : 'zero'; vg[k][0]++; vg[k][1] += valueOf(b); });
  const vrow = (k, label, note) => vg[k][0] ? `<li><b>${fmtInt(vg[k][0])}</b> ${label}: ${fmtMoney(vg[k][1])}${note ? ` <span style="opacity:.75">(${note})</span>` : ''}</li>` : '';
  const vtip = `<span class="tipbox" role="tooltip"><strong>How this adds up</strong> across your ${fmtInt(n)} counted books:<ul>${vrow('paid', 'price you paid', 'from your Amazon orders or typed in')}${vrow('now', "today's Kindle price", "used until the price you paid is found")}${vrow('guess', 'guessed', `${fmtMoney(S.settings.defPrice)} each, from Settings`)}${vg.zero[0] ? `<li><b>${fmtInt(vg.zero[0])}</b> free: $0</li>` : ''}</ul>Prices paid are read from up to 150 orders per sync, so this gets more exact with every sync. Click a book's title to type in a price.</span>`;
  $('#tValueSub').innerHTML = !S.showMoney ? 'Hidden' : `<span class="tip" tabindex="0">${[vg.paid[0] ? `${fmtInt(vg.paid[0])} paid` : '', vg.now[0] ? `${fmtInt(vg.now[0])} at today's price` : '', vg.guess[0] ? `${fmtInt(vg.guess[0])} guessed` : '', vg.zero[0] ? `${fmtInt(vg.zero[0])} free` : ''].filter(Boolean).join(' · ') || 'no books yet'}${vtip}</span>`;
  $('#revealHint').textContent = S.showMoney ? 'Click to hide' : 'Click to reveal';
  $('#revealValue').setAttribute('aria-pressed', S.showMoney);
  // Lead with what's still to read; a small labeled table shows the whole library and your pace. Units spelled out.
  const hrsWord = p => { const h = hoursFor(p); if (h < 1) { const m = Math.round(h * 60); return `${m} minute${m === 1 ? '' : 's'}`; } const r = Math.round(h); return `${fmtInt(r)} hour${r === 1 ? '' : 's'}`; };
  const paceDays = leftPages / Math.max(1, S.settings.pagesPerDay);
  const paceTxt = paceDays > 730 ? `${(paceDays / 365).toFixed(1)} years` : paceDays >= 1.5 ? `${fmtInt(paceDays)} days` : paceDays > 0 ? 'about a day' : 'nothing left';
  $('#tHours').innerHTML = `${hrsWord(leftPages)} <span class="unitw">left</span>`;
  const trow = (label, mid, right, hl) => `<span class="tk${hl ? ' hl' : ''}">${label}</span><span class="tn${hl ? ' hl' : ''}">${mid}</span><span class="th${hl ? ' hl' : ''}">${right}</span>`;
  $('#tHoursSub').innerHTML = `<span class="trows">${trow('Whole library', `${fmtInt(allPages)} pages`, hrsWord(allPages))}${trow('Still to read', `${fmtInt(Math.round(leftPages))} pages`, hrsWord(leftPages), true)}${trow('At your pace', `${fmtInt(S.settings.pagesPerDay)} pages/day`, paceTxt)}</span>`;
  const pk = Object.keys(PACES).find(k => PACES[k] === S.settings.pagesPerDay);
  document.querySelectorAll('[data-pace]').forEach(b => b.setAttribute('aria-pressed', b.dataset.pace === pk));
  $('#paceNote').textContent = `${S.settings.pagesPerDay} pages a day` + (pk ? '' : ' (custom, set in Settings)');
  $('#tUnread').textContent = pctText(pct);
  $('#tUnreadSub').textContent = `${fmtInt(pile.length)} of ${fmtInt(n)} books never opened`;

  // pile
  $('#pileH').textContent = `${fmtInt(pile.length)} unread book${pile.length === 1 ? '' : 's'}`;
  const nNew = pile.filter(isNew).length;
  $('#pileNew').hidden = !nNew;
  $('#pileNew').innerHTML = nNew ? `<i></i>${nNew} bought in the last 5 days, shown first` : '';
  const stack = $('#stack');
  if (!pile.length) {
    stack.innerHTML = n ? '<div class="pile-empty">The shelf is empty. Every book has been opened.</div>' : '<div class="pile-empty muted">Import your library to fill the shelf.</div>';
  } else {
    const PHONE = window.matchMedia('(max-width: 640px)').matches; // a phone gets a short shelf; the rest is counted below it
    const drawShelf = (SHELF, maxPiles, scale) => {
      // Within any group: just-bought books first (newest first), then the longest-waiting
      const pickOrder = list => [...list.filter(isNew).sort((a,b) => b.date.localeCompare(a.date)), ...list.filter(b => !isNew(b)).sort((a,b) => (a.date || '9').localeCompare(b.date || '9'))];
      let shown, globeG = [], comicG = [], globeSmallest = false;
      if (S.settings.spineMode === 'genre') {
        // The shelf doubles as a chart: each genre gets spines in proportion to its share of the unread pile, grouped together, biggest first
        const groups = {}; pile.forEach(b => { const g = GENRES[b.genre] ? b.genre : 'unknown'; (groups[g] ||= []).push(b); });
        let slots = Math.min(SHELF, pile.length);
        let keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
        // A phone's 10 spines are 10% each, too coarse for small genres: under 5% they're the lands on a spinning globe, under 3% a comic lying on the shelf
        if (PHONE && pile.length > SHELF) {
          const share = g => groups[g].length / pile.length;
          // Unknown isn't a genre, so it never becomes globe land or comic panels (it stays in the key below)
          // One spine is 1/15 of the pile: under that a genre is globe land, under half that it's on the comic
          const spine = 1 / SHELF;
          comicG = keys.filter(g => g !== 'unknown' && share(g) < spine / 2); globeG = keys.filter(g => g !== 'unknown' && share(g) >= spine / 2 && share(g) < spine);
          // The globe is always there: if no genre falls in its range, it takes the smallest genre that would have had spines
          if (!globeG.length) { const rest = keys.filter(g => g !== 'unknown' && !comicG.includes(g)); if (rest.length > 1) { globeG = [rest[rest.length - 1]]; globeSmallest = true; } }
          keys = keys.filter(g => !globeG.includes(g) && !comicG.includes(g) && !(g === 'unknown' && share(g) < spine));
          if (globeG.length) slots--;
        }
        const big = keys.reduce((a, g) => a + groups[g].length, 0) || 1;
        const exact = keys.map(g => groups[g].length / big * slots);
        const seats = exact.map(Math.floor);
        let left = slots - seats.reduce((a, b) => a + b, 0);
        exact.map((x, i) => [x - seats[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { seats[i]++; left--; } }); // largest remainders get the leftover seats
        shown = keys.flatMap((g, i) => pickOrder(groups[g]).slice(0, seats[i]));
        // Just-bought books lead the whole shelf whatever their genre; the genre groups follow
        shown = [...shown.filter(isNew).sort((a, b) => b.date.localeCompare(a.date)), ...shown.filter(b => !isNew(b))];
      } else shown = pickOrder(pile).slice(0, SHELF);
      const cloth = n => `var(--cloth-${n % 6 + 1})`;
      const gmode = S.settings.spineMode === 'genre';
      const tipOf = (b, p, nw) => `${esc(b.title)} — ${esc(b.author)} · ${p} pages${genreLabel(b) ? ' · ' + esc(genreLine(b)) + (tagsShown(b).length ? '\n' + esc(tagsShown(b).slice(0, 4).join(', ')) : b.genreSub && b.genreSub !== genreLabel(b) ? ' › ' + esc(b.genreSub) : '') : ''}${nw ? ' · bought ' + b.date : ''}`;
      // One book's spine. In By genre mode a second genre shows as two bands in its color; otherwise the bands are decoration.
      const spineOf = (b, i, flat) => {
        const h = hash(b.id + b.title), p = pagesOf(b), nw = isNew(b);
        const w = Math.round(Math.max(18, Math.min(46, 12 + p / 22)) * scale); // thinner spines when a full bookcase has to hold 100
        const ht = 112 + (h % 46);
        const r = (!flat && h % 23 === 0 && i > 0) ? -4 : 0, lean = !nw && r !== 0;
        const c = gmode ? `var(--g-${GENRES[b.genre] ? b.genre : 'unknown'})` : cloth(h);
        const two = gmode && b.genre2 && GENRES[b.genre2] && b.genre2 !== b.genre;
        const cls = `spine ${two ? 'g2' : gmode ? 'plain' : 's' + (h >> 3) % 5}${nw ? ' new' : ''}${lean ? ' lean' : ''}`;
        const size = flat ? `--len:${Math.round(ht * .78)}px;--th:${Math.max(15, Math.round(w * .72))}px;--dx:${(h >> 5) % 9}px` : `--h:${ht}px;--w:${w}px;--r:${lean ? r : 0}deg`;
        return `<span class="${cls}" style="${size};--c:${c}${two ? `;--c2:var(--g-${b.genre2})` : ''}" title="${tipOf(b, p, nw)}"><b>${esc(b.title)}</b></span>`;
      };
      // Now and then two or three books lie flat in a little pile, like a real shelf (never the just-bought ones)
      let html = '<div class="bookcase">', piles = 0;
      for (let i = 0; i < shown.length; i++) {
        const b = shown[i], h = hash(b.id + b.title);
        if (!PHONE && piles < maxPiles && i > 2 && h % 11 === 0 && !isNew(b)) { // no piles on a phone's short shelf
          const n = 2 + (h >> 4) % 2, seg = shown.slice(i, i + n), cut = seg.findIndex(isNew), pile2 = cut < 0 ? seg : seg.slice(0, cut);
          if (pile2.length >= 2) { piles++; html += `<span class="lay">${pile2.map(x => spineOf(x, i, true)).join('')}</span>`; i += pile2.length - 1; continue; }
        }
        html += spineOf(b, i, false);
        if (!gmode && i % 23 === 11 && i < shown.length - 3) { const set = ORNAMENTS[document.documentElement.dataset.theme] || ORNAMENTS.default, k = set[(i / 23 | 0) % set.length]; html += `<span class="decor orn" aria-hidden="true" style="width:${DECOR[k][0]}px;height:${DECOR[k][1]}px">${DECOR[k][2]}</span>`; }
      }
      if (globeG.length || comicG.length) {
        const pct = g => `${GENRES[g]} ${Math.round(pile.filter(b => (GENRES[b.genre] ? b.genre : 'unknown') === g).length / pile.length * 100)}%`;
        if (globeG.length) html += `<span class="gx gx-globe" data-g="${globeG.join(' ')}" title="${globeSmallest ? 'Your smallest genre' : `Genres under ${Math.round(100 / SHELF)}% of your unread books`}: ${esc(globeG.map(pct).join(', '))}">${smallGenreSvg(globeG)}</span>`;
        if (comicG.length) html += `<span class="gx" title="Genres under ${Math.round(50 / SHELF)}% of your unread books: ${esc(comicG.map(pct).join(', '))}">${comicSvg(comicG)}</span>`;
      }
      html += '</div>';
      const gl = $('#genreLegend');
      if (S.settings.spineMode === 'genre') {
        const cnt = {}; pile.forEach(b => { const g = GENRES[b.genre] ? b.genre : 'unknown'; cnt[g] = (cnt[g] || 0) + 1; });
        gl.innerHTML = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).map(g => `<span${g === 'nonfiction' ? ` title="${esc([...new Set(pile.filter(b => b.genre === 'nonfiction').map(b => b.genreName).filter(Boolean))].join(', '))}"` : ''}><i style="background:var(--g-${g})"></i>${GENRES[g]} <span class="num muted">${cnt[g]} · ${Math.round(cnt[g] / pile.length * 100)}%</span></span>`).join('')
          + (pile.some(b => b.genreSrc === 'guess') ? `<span class="muted">${fmtInt(pile.filter(b => b.genreSrc === 'guess').length)} genres are guessed from the book's title, because Amazon has no store page for them.</span>` : '')
          + (globeG.length || comicG.length ? `<span class="muted">${globeG.length ? (globeSmallest ? `The globe holds your smallest genre, ${esc(GENRES[globeG[0]])}.` : `The globe holds the genres under ${Math.round(100 / SHELF)}%.`) : ''}${globeG.length && comicG.length ? ' ' : ''}${comicG.length ? `The comic holds the ones under ${Math.round(50 / SHELF)}%.` : ''}</span>` : '');
        gl.hidden = false;
      } else gl.hidden = true;
      if (pile.length > shown.length) html += `<div class="more">+ ${fmtInt(pile.length - shown.length)} more that didn't fit on the shelf${S.settings.spineMode === 'genre' ? ', in the same proportions' : ''}</div>`;
      stack.innerHTML = html;
    };
    // A computer's bookcase has at most 3 shelves and holds up to 100 books. If they don't fit, the spines get thinner
    // (and fewer books lie flat); only on a window too narrow for that do fewer books go on the shelves
    const shelfFit = () => {
      const bc = stack.querySelector('.bookcase'); if (PHONE || !bc) return 0;
      const cs = getComputedStyle(bc), row = parseFloat(cs.lineHeight) || 176, top = bc.getBoundingClientRect().top + parseFloat(cs.borderTopWidth);
      const rowOf = el => Math.floor((el.getBoundingClientRect().bottom - top - 1) / row);
      // the end of the last shelf keeps room for the bookend and its plants, vases and the like (decorShelf puts them there)
      const kids = [...bc.children], last = kids[kids.length - 1];
      const full = rowOf(last) === 2 && bc.getBoundingClientRect().right - 20 - last.getBoundingClientRect().right < DECOR_ROOM;
      if (!full && !kids.some(el => rowOf(el) > 2)) return 0;
      return Math.max(1, [...bc.querySelectorAll('.spine')].filter(el => rowOf(el) <= 2).length - 1);
    };
    let cap = PHONE ? 15 : 100, maxPiles = 99, scale = 1;
    // the same window width and pile as last time: start from the fit found then (a redraw happens on every edit)
    const fitKey = [stack.clientWidth, pile.length, S.settings.spineMode, document.documentElement.dataset.theme].join('|'), memo = shelfMemo.key === fitKey;
    if (memo) ({cap, maxPiles, scale} = shelfMemo);
    for (let tries = memo ? 1 : 0; tries < 20; tries++) {
      drawShelf(cap, maxPiles, scale); const fit = shelfFit(); if (!fit) break;
      if (tries === 0) { // first guess straight from the widths: how much thinner the spines must be for 3 shelves
        const bc = stack.querySelector('.bookcase'), room = 3 * (bc.clientWidth - 20) * .94 - DECOR_ROOM;
        let sw = 0, other = 0;
        for (const el of bc.children) { const cs = getComputedStyle(el), w = el.offsetWidth + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight); if (el.classList.contains('spine')) sw += w; else other += w; }
        maxPiles = 3; scale = Math.max(.38, Math.min(.98, (room - Math.min(other, 3 * 130)) / (sw || 1))); continue;
      }
      if (scale > .38) scale = Math.max(.38, scale - .03); else cap = Math.min(cap - 1, fit);
    }
    shelfMemo = {key: fitKey, cap, maxPiles, scale};
    requestAnimationFrame(decorShelf);
  }
  $('#fValue').textContent = mask(pileValue); $('#fValue').classList.toggle('masked', !S.showMoney);
  $('#fHours').textContent = fmtHours(hoursFor(pilePages));
  const days = leftPages / Math.max(1, S.settings.pagesPerDay);
  if (leftPages > 0) {
    const d = new Date(Date.now() + days * 864e5);
    $('#fClear').textContent = d.toLocaleDateString(undefined, {month:'short', year:'numeric'});
    $('#fClearL').textContent = `everything read at ${S.settings.pagesPerDay} pages a day (${days > 730 ? (days/365).toFixed(1) + ' years' : fmtInt(days) + ' days'})${QUIP}`;
  } else { $('#fClear').textContent = 'Done'; $('#fClearL').textContent = 'nothing left to read'; }
  const dated = pile.filter(b => b.date && !b.dateEst).sort((a,b) => a.date.localeCompare(b.date));
  if (dated.length) {
    const o = dated[0], y = yearsAgo(o.date);
    // Age of the oldest unread book: how long it has sat since you bought it (reading pace doesn't change this)
    const mo = Math.round(y * 12);
    $('#fOldest').textContent = y >= 1 ? `${y.toFixed(1)} years` : `${mo} month${mo === 1 ? '' : 's'}`;
    $('#fOldestL').innerHTML = `<i>${esc(o.title)}</i> has been waiting this long for you to read it (since ${esc(new Date(o.date).toLocaleDateString([], {month: 'long', year: 'numeric'}))})`;
  } else { $('#fOldest').textContent = '—'; $('#fOldestL').textContent = 'oldest unread book'; }
  $('#fReading').textContent = fmtInt(by.reading.length);
  const stalled = by.reading.filter(isStalled).length;
  $('#fReadingL').innerHTML = 'started but not finished' + (stalled ? ` · <button type="button" class="linkbtn" id="stalledLink">${stalled} stalled for over a year, sort them</button>` : '');
  if (stalled) $('#stalledLink').onclick = () => { S.filter = 'stalled'; S.limit = PAGE_ROWS; renderShelf(); document.querySelector('#shelfH').scrollIntoView({behavior: 'smooth'}); };
  const yr = Date.now() - 3.156e10;
  const boughtYr = bs.filter(b => b.date && new Date(b.date) >= yr).length;
  const doneYr = bs.filter(b => b.status === 'finished' && b.date && new Date(b.date) >= yr).length;
  $('#fRate').textContent = `${boughtYr} : ${doneYr}`;
  $('#fRate').nextElementSibling.textContent = 'added vs finished of those, last 12 months';

  const verdict = !n ? 'Nothing here yet.' :
    pct >= 100 ? `Not one book opened yet. <strong>All ${fmtInt(n)}</strong> are still waiting for you.` :
    pct >= 90 ? `You've barely cracked a spine. <strong>${pctText(pct)}</strong> of your library has never been opened.` :
    pct >= 60 ? `You've read less than half of what you own. <strong>${pctText(pct)}</strong> of your library has never been opened.` :
    pct >= 35 ? `A well-stocked shelf. <strong>${pctText(pct)}</strong> unread, about ${fmtHours(hoursFor(pilePages))} of reading waiting for you.` :
    pct > 0 ? `Mostly under control. Only <strong>${pctText(pct)}</strong> of your library is unread.` :
    'A clean conscience. You have read or started everything you own.';
  $('#verdict').innerHTML = verdict + (estPages ? ` <span class="muted" style="font-size:.85rem">(${fmtInt(estPages)} books use the default page count.)</span>` : '');

  const order = ['finished','reading','abandoned','unread'];
  $('#meter').innerHTML = order.map(k => n ? `<i style="width:${by[k].length / n * 100}%;background:${STATUS_COLOR[k]}"></i>` : '').join('');
  $('#meterLegend').innerHTML = order.map(k => `<span><i style="background:${STATUS_COLOR[k]}"></i>${STATUS[k]} <span class="num muted">${by[k].length}</span></span>`).join('');

  // status list
  // By status (#6): a small table so books and pages each have a labeled column, with each status's share of the books
  const allBk = order.reduce((a, k) => a + by[k].length, 0), stPages = k => by[k].reduce((a, b) => a + pagesOf(b), 0);
  const stRows = order.map(k => `<tr><td><i style="background:${STATUS_COLOR[k]}"></i>${STATUS[k]}</td><td>${fmtInt(by[k].length)}<span class="pc">${pctText(allBk ? by[k].length / allBk * 100 : 0)}</span></td><td>${fmtInt(stPages(k))}</td></tr>`).join('');
  // The unread pile at a glance (#11): its shortest and longest books, the average length, and how many are quick reads
  const known = pile.filter(b => b.pages > 0).sort((a, b) => a.pages - b.pages);
  const shortB = known[0], longB = known[known.length - 1];
  const quick = known.filter(b => b.pages < 200).length;
  const bookRow = (label, b) => b ? `<div class="two"><span>${label}</span><span class="bk" title="${esc(b.title)} — ${esc(b.author || '')}">${esc(b.title)}</span><span class="num">${fmtInt(b.pages)} pages</span></div>` : '';
  $('#statusList').innerHTML = `<table class="sttab"><thead><tr><th>Status</th><th>Books</th><th>Pages</th></tr></thead><tbody>${stRows}<tr class="tot"><td>All counted</td><td>${fmtInt(allBk)}</td><td>${fmtInt(order.reduce((a, k) => a + stPages(k), 0))}</td></tr></tbody></table>` +
    (known.length ? `<div class="stsub">Your unread books</div>` + bookRow('Shortest', shortB) + (known.length > 1 ? bookRow('Longest', longB) : '') +
      `<div><span>Average length</span><span class="num">${fmtInt(Math.round(known.reduce((a, b) => a + b.pages, 0) / known.length))} pages</span></div>` +
      `<div><span title="Unread books under 200 pages: an evening or two each">Quick reads (under 200 pages)</span><span class="num">${fmtInt(quick)} ${quick === 1 ? 'book' : 'books'}</span></div>` : '') +
    `<div class="stsub">Also</div>` +
    `<div><span title="Free, Kindle Unlimited and Prime Reading books, plus books shared with you, borrowed and samples">Free, KU and Prime</span><span class="num">${fmtInt(S.books.filter(b => b.source !== 'purchase').length)} books</span></div>` +
    `<div><span>Average rating</span><span class="num">${(() => { const r = bs.filter(b => b.rating > 0); return r.length ? (r.reduce((a,b) => a + b.rating, 0) / r.length).toFixed(1) + ' ★' : '—'; })()}</span></div>`;
  // This year (#9): books added and money spent since January 1, compared with the same point last year
  const tnow = new Date(), cy = tnow.getFullYear(), md = tnow.toISOString().slice(5, 10);
  const realDate = b => b.date && !b.dateEst;
  const thisYr = bs.filter(b => realDate(b) && b.date.startsWith(cy + '-'));
  const lastYrSoFar = bs.filter(b => realDate(b) && b.date.startsWith((cy - 1) + '-') && b.date.slice(5, 10) <= md).length;
  const spentYr = thisYr.reduce((a, b) => a + (hasPaid(b) ? +b.price : 0), 0), unknownYr = thisYr.filter(b => b.source === 'purchase' && !hasPaid(b)).length;
  const spentAll = bs.reduce((a, b) => a + (hasPaid(b) ? +b.price : 0), 0);
  $('#yrH').textContent = `${cy} so far`;
  $('#yrBooks').textContent = fmtInt(thisYr.length);
  $('#yrBooksL').textContent = `books added${lastYrSoFar || thisYr.length ? ` · ${fmtInt(lastYrSoFar)} by now last year` : ''}`;
  $('#yrSpent').textContent = mask(spentYr); $('#yrSpentL').textContent = 'spent this year' + (unknownYr ? ` · ${fmtInt(unknownYr)} without a known price` : '');
  $('#yrMonth').textContent = mask(spentYr / (tnow.getMonth() + tnow.getDate() / 31));
  $('#yrAll').textContent = mask(spentAll); $('#yrAllL').textContent = 'spent in all (known prices)';
  ['#yrSpent', '#yrMonth', '#yrAll'].forEach(id => $(id).classList.toggle('masked', !S.showMoney));

  // years
  const yrs = {};
  bs.forEach(b => { if (!b.date) return; const y = b.date.slice(0,4); (yrs[y] ||= {finished:0, reading:0, unread:0, abandoned:0})[b.status]++; });
  // Every year from the first purchase to now, so quiet years show as dips instead of disappearing
  const ys = Object.keys(yrs).map(Number);
  const keys = [];
  if (ys.length) { const hi = Math.max(...ys, new Date().getFullYear()); for (let y = Math.max(Math.min(...ys), hi - 24); y <= hi; y++) { keys.push(String(y)); yrs[y] ||= {finished:0, reading:0, unread:0, abandoned:0}; } }
  const allV = {finished:0, reading:0, unread:0, abandoned:0}; bs.forEach(b => { if (b.status in allV) allV[b.status]++; });
  const yearText = y => {
    const v = y === 'all' ? allV : yrs[y], t = v.finished + v.reading + v.unread + v.abandoned;
    const parts = [`<span style="color:var(--ok)">${v.finished} read</span>`];
    if (v.reading) parts.push(`<span style="color:var(--accent)">${v.reading} reading</span>`);
    if (v.abandoned) parts.push(`${v.abandoned} DNF`);
    parts.push(`<span style="color:var(--shame)">${v.unread} unread</span>`);
    return `<b>${y === 'all' ? 'All books counted' : y}</b>: ${t} book${t === 1 ? '' : 's'} · ${parts.join(' · ')}`;
  };
  const box = $('#years');
  let capped = false;
  if (!keys.length) box.innerHTML = '<p class="muted" style="align-self:center">No purchase dates yet.</p>';
  else {
    // Stacked bars on a true scale, except unusually tall years: those are cut off (with a break mark)
    // so one big buying year doesn't flatten the rest. Numbers above bars are always exact.
    const W = Math.max(260, box.clientWidth || 320), H = 170, padL = 2, padR = 2, padT = 22, padB = 22;
    const tot = y => order.reduce((a, k) => a + yrs[y][k], 0);
    const nz = keys.map(tot).filter(Boolean).sort((a, b) => a - b);
    const maxT = Math.max(1, ...nz);
    const cap = Math.min(maxT, Math.max(10, Math.ceil((nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.75))] || 1) * 1.6)));
    const slot = (W - padL - padR) / keys.length, bw = Math.max(4, Math.min(34, slot - 4));
    const plotH = H - padT - padB, base = H - padB;
    const Hof = v => Math.min(v, cap) / cap * plotH;
    const every = Math.ceil(keys.length / 12);
    let bars = '', labels = '', hits = '', prevCut = false, lift = 0;
    keys.forEach((y, i) => {
      const t = tot(y), cx = padL + slot * i + slot / 2, x = cx - bw / 2, cut = t > cap;
      if (cut) capped = true;
      if (!t) prevCut = false;
      if (t) {
        const h = Hof(t); let yb = base;
        order.forEach(k => {
          const n = yrs[y][k]; if (!n) return;
          const sh = h * n / t; yb -= sh;
          bars += `<rect x="${x}" y="${yb}" width="${bw}" height="${Math.max(sh - (yb > base - h + 0.5 ? 1 : 0), 0.5)}" fill="${STATUS_COLOR[k]}"/>`;
        });
        prevCut = cut;
        if (cut) bars += `<path d="M${x - 2},${base - h + 14} l${bw + 4},-6 M${x - 2},${base - h + 21} l${bw + 4},-6" stroke="var(--paper)" stroke-width="3"/>`;
        lift = cut && prevCut ? (lift ? 0 : 11) : 0; // neighbouring cut-off bars: stagger their labels so they don't collide
        labels += `<text x="${cx}" y="${base - h - 6 - lift}" text-anchor="middle" class="yn">${t}</text>`;
      }
      if (i % every === 0 || i === keys.length - 1) labels += `<text x="${cx}" y="${H - 6}" text-anchor="middle" class="yy">'${y.slice(2)}</text>`;
      hits += `<rect class="yhit" data-y="${y}" data-i="${i}" x="${padL + slot * i}" y="0" width="${slot}" height="${H}" fill="transparent"/>`;
    });
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Books added per year, stacked by status">
      <line x1="${padL}" x2="${W - padR}" y1="${base}" y2="${base}" class="ybase"/>${bars}
      <rect class="ycursor" x="0" y="${padT - 6}" width="${slot}" height="${plotH + 6}" rx="4" visibility="hidden"/>${labels}${hits}</svg>`;
    box._slot = slot; box._padL = padL;
  }
  const undated = bs.filter(b => !b.date).length;
  const baseInfo = yearText('all');
  const undatedTxt = (undated ? ` <span class="muted">(${fmtInt(undated)} books have no purchase date)</span>` : '') + (capped ? ' <span class="muted">Bars with a break mark are cut off so the others stay readable; the numbers are exact.</span>' : '');
  const cursor = () => box.querySelector('.ycursor');
  // Reading status rings: every year until you point at one, then just that year
  const RC = 2 * Math.PI * 26;
  const rk = ['finished','reading','abandoned','unread'];
  $('#yearRings').innerHTML = `<div class="rhead"><span id="ringsTitle"></span><b id="ringsTotal"></b></div><div class="rrow">` + rk.map(k =>
    `<div><svg viewBox="0 0 64 64" role="img" aria-label="${STATUS[k]}"><circle class="rt" cx="32" cy="32" r="26" stroke="${STATUS_COLOR[k]}"/><circle class="rv" id="rv-${k}" cx="32" cy="32" r="26" stroke="${STATUS_COLOR[k]}" transform="rotate(-90 32 32)" stroke-dasharray="0 ${RC}"/><text class="rp" id="rp-${k}" x="32" y="32">0%</text></svg>` +
    `<div class="rl" style="color:${STATUS_COLOR[k]}">${STATUS[k]}</div><div class="rn muted" id="rn-${k}"></div></div>`).join('') + `</div>`;
  const setRings = y => {
    const v = y === 'all' ? allV : yrs[y], t = rk.reduce((a, k) => a + v[k], 0);
    $('#ringsTitle').textContent = y === 'all' ? 'Reading status · all years' : `Reading status · ${y}`;
    $('#ringsTotal').textContent = `${fmtInt(t)} book${t === 1 ? '' : 's'}`;
    rk.forEach(k => {
      const p = t ? v[k] / t : 0;
      $('#rv-' + k).setAttribute('stroke-dasharray', `${v[k] && p * RC < 0.5 ? 0.5 : p * RC} ${RC}`);
      $('#rv-' + k).style.opacity = v[k] ? 1 : 0;
      const rp = $('#rp-' + k); rp.textContent = pctText(p * 100); rp.style.fontSize = rp.textContent.length > 4 ? '80%' : ''; // 99.5% needs a little less room
      $('#rn-' + k).textContent = `${fmtInt(v[k])} book${v[k] === 1 ? '' : 's'}`;
    });
  };
  setRings('all');
  $('#yearInfo').innerHTML = undatedTxt;
  box.onmouseleave = () => { setRings('all'); $('#yearInfo').innerHTML = undatedTxt; const c = cursor(); if (c) c.setAttribute('visibility', 'hidden'); };
  box.onmousemove = box.onclick = e => {
    const r = e.target.closest && e.target.closest('.yhit'); if (!r) return;
    $('#yearInfo').innerHTML = undatedTxt; setRings(r.dataset.y);
    const c = cursor(); if (c) { c.setAttribute('x', box._padL + box._slot * +r.dataset.i); c.setAttribute('visibility', 'visible'); }
  };
  $('#yearLegend').innerHTML = order.map(k => `<span><i style="background:${STATUS_COLOR[k]}"></i>${STATUS[k]}</span>`).join('');

  // authors
  const au = {};
  bs.forEach(b => { const a = b.author || 'Unknown'; (au[a] ||= {n:0, unread:0}); au[a].n++; if (b.status === 'unread') au[a].unread++; });
  const top = Object.entries(au).sort((a,b) => b[1].n - a[1].n || b[1].unread - a[1].unread).slice(0, 8);
  const amax = top[0]?.[1].n || 1;
  $('#authors').innerHTML = top.length ? top.map(([a, v]) => `<div class="arow"><span class="name">${esc(a)}</span><span class="num muted">${v.n}${v.unread ? ` · <span style="color:var(--shame)">${v.unread} unread</span>` : ''}</span><div class="track"><i style="width:${(v.n - v.unread) / amax * 100}%;background:var(--ink)"></i><i style="width:${v.unread / amax * 100}%;background:var(--shame)"></i></div></div>`).join('') : '<p class="muted">No authors yet.</p>';
}

// Shared, Kindle Unlimited, Prime Reading and borrowed books: optionally kept on their own tab (Settings)
const SHARED_KINDS = {shared:'Shared with me', ku:'Kindle Unlimited', prime:'Prime Reading', other:'Borrowed'};
const isSharedKind = b => b.source in SHARED_KINDS;
function renderShelf() {
  const sep = !!S.settings.sharedTab;
  if (!sep || !S.libTab) S.libTab = 'mine';
  const nShared = S.books.filter(isSharedKind).length;
  $('#libTabs').hidden = !sep;
  if (sep) $('#libTabs').innerHTML = [['mine', 'My books', S.books.length - nShared], ['shared', 'Shared & borrowed', nShared]].map(([k, l, n]) => `<button type="button" role="tab" data-t="${k}" aria-pressed="${S.libTab === k}" aria-selected="${S.libTab === k}">${l}<span class="c">${fmtInt(n)}</span></button>`).join('');
  const onShared = sep && S.libTab === 'shared';
  const books = sep ? S.books.filter(b => onShared ? isSharedKind(b) : !isSharedKind(b)) : S.books;
  // Status chips count the same books as the charts (counted ones); books left out of totals get their own chip
  const counts = {all:books.length, unread:0, reading:0, finished:0, abandoned:0, stalled:0, excluded:0};
  books.forEach(b => { if (counted(b)) { counts[b.status] = (counts[b.status] || 0) + 1; if (isStalled(b)) counts.stalled++; } else counts.excluded++; });
  if (S.filter === 'stalled' && !counts.stalled) S.filter = 'all';
  const labels = {all:'All', unread:'Shelf of Shame', reading:'Reading', finished:'Finished', abandoned:'DNF'};
  if (counts.stalled) labels.stalled = 'Stalled 1 yr+';
  if (counts.excluded) labels.excluded = 'Not counted';
  if (S.filter === 'excluded' && !counts.excluded) S.filter = 'all';
  if (onShared) { // on the shared tab the chips sort by how you got the book instead of by status
    for (const k of Object.keys(labels)) delete labels[k];
    labels.all = 'All'; counts.all = books.length;
    for (const [k, l] of Object.entries(SHARED_KINDS)) { const n = books.filter(b => b.source === k).length; if (n) { labels['src:' + k] = l; counts['src:' + k] = n; } }
    if (!labels[S.filter]) S.filter = 'all';
  } else if (S.filter.startsWith('src:')) S.filter = 'all';
  $('#chips').innerHTML = Object.keys(labels).map(k => `<button class="chip" data-f="${k}" aria-pressed="${S.filter === k}">${labels[k]}<span class="c">${counts[k] || 0}</span></button>`).join('');

  // Tag filter: every tag in this tab, most-used first; a tag click in the table picks it too
  const tc = {}; books.forEach(b => (b.tags || []).forEach(t => { tc[t] = (tc[t] || 0) + 1; }));
  const tlist = Object.keys(tc).sort((a, b) => tc[b] - tc[a] || a.localeCompare(b));
  if (S.tag && !tc[S.tag]) S.tag = '';
  $('#tagSel').hidden = !tlist.length;
  $('#tagSel').innerHTML = '<option value="">All tags</option>' + tlist.map(t => `<option value="${esc(t)}"${t === S.tag ? ' selected' : ''}>${esc(t)} (${tc[t]})</option>`).join('');
  $('#tagSel').classList.toggle('on', !!S.tag);
  const q = S.q.trim().toLowerCase();
  let list = books.filter(b => (!S.tag || (b.tags || []).includes(S.tag)) && (S.filter === 'all' || (S.filter.startsWith('src:') ? b.source === S.filter.slice(4) : (S.filter === 'excluded' ? !counted(b) : S.filter === 'stalled' ? counted(b) && isStalled(b) : counted(b) && b.status === S.filter))) && (!q || (b.title + ' ' + b.author).toLowerCase().includes(q)));
  const {k, dir} = S.sort;
  const rank = {unread:0, reading:1, abandoned:2, finished:3};
  list.sort((a, b) => {
    let x = a[k], y = b[k];
    if (k === 'status') { x = rank[a.status]; y = rank[b.status]; }
    if (k === 'title') { x = (a.title || '').toLowerCase(); y = (b.title || '').toLowerCase(); }
    if (x == null || x === '') return 1; if (y == null || y === '') return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  document.querySelectorAll('th button').forEach(b => { if (b.dataset.k === k) b.dataset.dir = dir; else delete b.dataset.dir; });
  const shown = list.slice(0, S.limit);
  $('#rows').innerHTML = shown.length ? shown.map(b => {
    const src = (SOURCE[b.source] ? `<span class="pill">${SOURCE[b.source]}</span>` : '') + (isNew(b) ? '<span class="pill new">new</span>' : '') + (isStalled(b) ? `<span class="pill stalled" title="Started ${b.readingSince} and still not finished. Mark it Finished, or DNF if you've given up on it.">stalled 1 yr+</span>` : '');
    const pr = hasPaid(b) ? fmtMoney(+b.price) : b.kp != null && b.source !== 'free' && b.source !== 'device' ? `<span class="est" title="Today's Kindle price (not what you paid)">now ${fmtMoney(b.kp)}</span>` : (b.source === 'purchase' ? `<span class="est" title="Guess from Settings">~${fmtMoney(S.settings.defPrice)}</span>` : '—');
    const pg = b.pages > 0 ? fmtInt(b.pages) : `<span class="est">~${S.settings.defPages}</span>`;
    return `<tr data-id="${esc(b.id)}">
      <td style="min-width:220px"><div class="t-title" data-edit="${esc(b.id)}" tabindex="0">${esc(b.title)}${src}</div><div class="t-author">${esc(b.author || '')}</div>${b.genre && b.genre !== 'unknown' ? `<div class="t-genre"><span class="gsw"><i style="background:var(--g-${GENRES[b.genre] ? b.genre : 'unknown'})"></i>${esc(genreLabel(b))}${b.genreSrc === 'guess' ? '<span class="guessed" title="No Amazon store page for this book, so the genre is guessed from its title. Click the title to change it.">guessed</span>' : ''}</span>${b.genre2 && GENRES[b.genre2] && b.genre2 !== b.genre ? `<span class="plus">+</span><span class="gsw"><i style="background:var(--g-${b.genre2})"></i>${esc(GENRES[b.genre2])}</span>` : ''}${tagsShown(b).map(t => `<button type="button" class="tag${t === S.tag ? ' on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}</td>
      <td><select class="st ${b.status}" data-st="${esc(b.id)}" aria-label="Status">${Object.entries(STATUS).map(([v,l]) => `<option value="${v}"${v === b.status ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><div class="prog"><div class="track"><i style="width:${b.progress || 0}%"></i></div><span class="num muted" style="font-size:.75rem">${Math.round(b.progress || 0)}%</span></div></td>
      <td class="r num">${pg}</td>
      <td class="r num">${pr}</td>
      <td class="num muted" style="white-space:nowrap">${b.date || '—'}</td>
      <td class="stars">${b.rating ? '★'.repeat(b.rating) : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="empty-shelf">${S.books.length ? 'No books match.' : 'No books yet. Use <strong>Add book</strong>, or <strong>Settings → Import a file</strong>.'}</td></tr>`;
  $('#showMore').hidden = list.length <= S.limit;
  $('#showMore').textContent = `Show more (${fmtInt(list.length - S.limit)} left)`;
}

const toggleMoney = () => { S.showMoney = !S.showMoney; renderStats(); };
$('#revealValue').onclick = toggleMoney;
document.querySelectorAll('[data-reveal]').forEach(b => b.onclick = toggleMoney);

// ---------- shelf interactions ----------
$('#libTabs').addEventListener('click', e => { const t = e.target.closest('[data-t]'); if (!t) return; S.libTab = t.dataset.t; S.filter = 'all'; S.limit = PAGE_ROWS; renderShelf(); });
$('#chips').addEventListener('click', e => { const c = e.target.closest('[data-f]'); if (!c) return; S.filter = c.dataset.f; S.limit = PAGE_ROWS; renderShelf(); });
let qT; $('#q').addEventListener('input', e => { S.q = e.target.value; S.limit = PAGE_ROWS; clearTimeout(qT); qT = setTimeout(renderShelf, 180); }); // redraw after a short pause in typing
$('#tagSel').addEventListener('change', e => { S.tag = e.target.value; S.limit = PAGE_ROWS; renderShelf(); });
document.querySelector('thead').addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (!b) return; const k = b.dataset.k; S.sort = {k, dir: S.sort.k === k ? -S.sort.dir : (k === 'title' ? 1 : -1)}; renderShelf(); });
$('#showMore').addEventListener('click', () => { S.limit += PAGE_ROWS * 2; renderShelf(); });
$('#rows').addEventListener('change', e => {
  const id = e.target.dataset.st; if (!id) return;
  const b = S.books.find(x => x.id === id); if (!b) return;
  b.status = e.target.value; b.lock = true;
  if (b.status === 'reading') b.readingSince = new Date().toISOString().slice(0, 10);
  if (b.status === 'finished') b.progress = 100;
  if (b.status === 'unread') b.progress = 0;
  leaveDemoForEdit(); renderAll(); scheduleSave();
});
$('#rows').addEventListener('click', e => { const g = e.target.closest('[data-tag]'); if (g) { S.tag = S.tag === g.dataset.tag ? '' : g.dataset.tag; S.limit = PAGE_ROWS; renderShelf(); return; } const t = e.target.closest('[data-edit]'); if (t) openEdit(t.dataset.edit); });
$('#rows').addEventListener('keydown', e => { const t = e.target.closest('[data-edit]'); if (t && e.key === 'Enter') openEdit(t.dataset.edit); });
function leaveDemoForEdit() { /* edits to the example library stay on this page only */ }

// ---------- edit dialog ----------
let editing = null, delArmed = false;
function openEdit(id) {
  editing = id ? S.books.find(b => b.id === id) : null;
  const b = editing || {status:'unread', progress:0, source:'purchase', rating:0, date:new Date().toISOString().slice(0,10)};
  $('#editH').textContent = editing ? 'Edit book' : 'Add a book';
  $('#eTitle').value = b.title || ''; $('#eAuthor').value = b.author || ''; $('#eAsin').value = b.asin || '';
  $('#eStatus').value = b.status; $('#eProgress').value = Math.round(b.progress || 0);
  $('#ePages').value = b.pages || ''; $('#ePrice').value = b.price ?? ''; $('#eDate').value = b.date || '';
  $('#eSource').value = b.source || 'purchase'; $('#eRating').value = b.rating || 0;
  $('#eGenre').innerHTML = '<option value="">Look up automatically</option>' + Object.entries(GENRES).filter(([k]) => k !== 'unknown').map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#eGenre').value = b.genreSrc === 'manual' ? b.genre : '';
  $('#eGenre2').innerHTML = '<option value="">Look up automatically</option><option value="none">None</option>' + Object.entries(GENRES).filter(([k]) => k !== 'unknown' && k !== 'nonfiction').map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#eGenre2').value = b.genre2Src === 'manual' ? (b.genre2 || 'none') : '';
  $('#eTags').hidden = !(b.tags && b.tags.length); $('#eTags').textContent = b.tags && b.tags.length ? 'Amazon lists it under: ' + b.tags.join(', ') : '';
  $('#eDelete').hidden = !editing; delArmed = false; $('#eConfirm').textContent = '';
  $('#dlgEdit').showModal();
}
$('#editClose').onclick = () => $('#dlgEdit').close();
$('#eStatus').addEventListener('change', e => { if (e.target.value === 'finished') $('#eProgress').value = 100; if (e.target.value === 'unread') $('#eProgress').value = 0; });
$('#editForm').addEventListener('submit', e => {
  e.preventDefault();
  const num = v => v === '' ? null : +v;
  const data = {
    title: $('#eTitle').value.trim(), author: $('#eAuthor').value.trim(), asin: $('#eAsin').value.trim(),
    ...($('#eStatus').value === 'reading' && (!editing || editing.status !== 'reading') ? {readingSince: new Date().toISOString().slice(0, 10)} : {}),
    status: $('#eStatus').value, progress: Math.max(0, Math.min(100, +$('#eProgress').value || 0)),
    pages: num($('#ePages').value), price: num($('#ePrice').value), date: $('#eDate').value || '',
    ...(($('#eDate').value || '') !== ((editing && editing.date) || '') ? {dateManual: true, dateEst: false} : {}),
    ...(editing && String($('#ePrice').value) !== String(editing.price ?? '') ? {priceManual: true} : {}),
    source: $('#eSource').value, rating: +$('#eRating').value, lock: true,
    ...(editing && $('#eSource').value !== editing.source ? {sourceManual: true} : {}),
    ...($('#eGenre').value ? {genre: $('#eGenre').value, genreSrc: 'manual'} : (editing && editing.genreSrc === 'manual' ? {genre: '', genreSrc: '', genreV: 0} : {})),
  };
  // Second genre: picked by hand (or None), or worked out again from Amazon's tags for whatever the main genre is now
  const g2 = $('#eGenre2').value, mainG = data.genre !== undefined ? data.genre : editing && editing.genre;
  Object.assign(data, g2 ? {genre2: g2 === 'none' ? '' : g2, genre2Src: 'manual'} : {genre2: secondGenre(editing && editing.tags, mainG), genre2Src: ''});
  if (!data.title) return;
  if (editing) Object.assign(editing, data);
  else { leaveDemo(true); S.books.unshift({id: uid(), ...data}); }
  $('#dlgEdit').close(); renderAll(); scheduleSave(); toast(editing ? 'Saved' : 'Book added');
});
$('#eDelete').onclick = () => {
  if (!delArmed) { delArmed = true; $('#eConfirm').textContent = 'Click Delete again to remove it'; return; }
  S.books = S.books.filter(b => b !== editing);
  $('#dlgEdit').close(); renderAll(); scheduleSave(); toast('Book deleted');
};
$('#btnAdd').onclick = () => openEdit(null);

// ---------- settings ----------
let wipeArmed = false;
$('#btnSettings').onclick = () => {
  const s = S.settings;
  $('#sPages').value = s.defPages; $('#sPrice').value = s.defPrice; $('#sMin').value = s.minPerPage; $('#sDay').value = s.pagesPerDay;
  $('#sCur').value = s.currency; $('#sDone').value = s.doneAt; $('#sBorrowed').checked = s.borrowed; $('#sSharedTab').checked = !!s.sharedTab; $('#sSamples').checked = s.samples; $('#sGrAll').checked = !!s.grAll; $('#sExtras').checked = !!s.extras;
  wipeArmed = false; $('#wipeConfirm').textContent = '';
  $('#dlgSettings').showModal();
};
// ---------- themes ----------
const THEMES = [
  ['default', 'Default', 'Follows your device', ['#eceeea', '#1a1e21', '#27408b', '#a3322a']],
  ['cozy', 'Cozy', 'Warm, lamp-lit library', ['#16100b', '#211811', '#f0b25a', '#7d3a2c']],
  ['zon', 'Zon', 'Online bookstore', ['#131921', '#232f3e', '#ffd814', '#ffa41c']],
  ['halloween', 'Halloween', 'Spooky season', ['#0c0911', '#7b46c4', '#9be35a', '#ff8c2e']],
  ['light', 'Light', 'Always light', ['#f7f8f5', '#eceeea', '#27408b', '#2f6b45']],
  ['fruit', 'Fruit', 'Frosted glass and bright colors', ['#f2f2f7', '#ffffff', '#007aff', '#ff3b30']],
];
function applyTheme(t) {
  if (!t || t === 'default') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  try { localStorage.setItem('klc-theme', t || 'default'); } catch {}
  if (typeof decorShelf === 'function') requestAnimationFrame(decorShelf);
  // Tab and home-screen icon: the book with a cobweb in the Halloween theme, the book with its price tag otherwise
  // Swapping in a new <link> (not just changing href) makes Safari and Firefox notice too
  const ico = t === 'halloween' ? 'web' : 'tag';
  [['favicon', `icon-${ico}.png?v=2.1.0.0.8`], ['touchicon', `icon-${ico}-180.png?v=2.1.0.0.8`]].forEach(([id, href]) => {
    const old = document.getElementById(id); if (!old || old.getAttribute('href') === href) return;
    const n = old.cloneNode(); n.setAttribute('href', href); old.replaceWith(n);
  });
  const p = document.getElementById('themePick'); if (p) p.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', b.dataset.t === (t || 'default')));
}
$('#themePick').innerHTML = THEMES.map(([k, n, d, sw]) => `<button type="button" role="radio" aria-checked="false" data-t="${k}"><span class="sw">${sw.map(c => `<i style="background:${c}"></i>`).join('')}</span>${n}<small>${d}</small></button>`).join('');
// Until someone picks a theme, it follows their device: Fruit on iPhone, iPad and Mac, Default everywhere else
const deviceTheme = () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) ? 'fruit' : 'default';
const themePicked = () => { try { return !!localStorage.getItem('klc-theme-picked'); } catch { return false; } };
try { applyTheme(themePicked() ? (localStorage.getItem('klc-theme') || 'default') : deviceTheme()); } catch {} // before the library loads, so there's no flash
$('#themePick').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (!b) return; try { localStorage.setItem('klc-theme-picked', '1'); } catch {} S.settings.theme = b.dataset.t; applyTheme(b.dataset.t); scheduleSave(); });
$('#setClose').onclick = () => $('#dlgSettings').close();
// Clicking the dimmed area around Settings closes it, like the ×. A press that starts inside (e.g. selecting text) doesn't count.
{ const d = $('#dlgSettings'); let downOut = false; d.addEventListener('pointerdown', e => { downOut = e.target === d; }); d.addEventListener('click', e => { if (downOut && e.target === d) d.close(); downOut = false; }); }
$('#setForm').addEventListener('submit', e => {
  e.preventDefault();
  S.settings = {
    defPages: Math.max(1, +$('#sPages').value || DEFAULTS.defPages), defPrice: Math.max(0, +$('#sPrice').value || 0),
    minPerPage: Math.max(0.2, +$('#sMin').value || DEFAULTS.minPerPage), pagesPerDay: Math.max(1, +$('#sDay').value || DEFAULTS.pagesPerDay), paceSet: true,
    currency: $('#sCur').value, spineMode: S.settings.spineMode, theme: S.settings.theme, doneAt: Math.min(100, Math.max(50, +$('#sDone').value || 90)),
    borrowed: $('#sBorrowed').checked, sharedTab: $('#sSharedTab').checked, samples: $('#sSamples').checked, grAll: $('#sGrAll').checked, extras: $('#sExtras').checked,
  };
  $('#dlgSettings').close(); renderAll(); scheduleSave(); toast('Settings saved');
});
$('#wipe').onclick = () => {
  if (!wipeArmed) { wipeArmed = true; $('#wipeConfirm').textContent = 'Click again to delete every book'; return; }
  leaveDemo(true); S.books = []; $('#dlgSettings').close(); renderAll(); scheduleSave(); toast('Library cleared');
};

// ---------- import ----------
$('#impTabs').addEventListener('click', e => {
  const t = e.target.closest('[data-t]'); if (!t) return;
  document.querySelectorAll('#impTabs .tab').forEach(b => b.setAttribute('aria-selected', b === t));
  document.querySelectorAll('[data-p]').forEach(p => p.hidden = p.dataset.p !== t.dataset.t);
});
const openImport = () => { if ($('#dlgSettings').open) $('#dlgSettings').close(); $('#impResult').textContent = ''; $('#impResult').className = 'result'; $('#replace').checked = false; $('#dlgImport').showModal(); };
$('#btnImport').onclick = openImport; $('#bannerImport').onclick = () => syncOn ? runSync(true) : openWizard('welcome');
$('#btnSync').onclick = () => runSync(true);
$('#bannerEmpty').onclick = () => { leaveDemo(true); renderAll(); scheduleSave(); };

const drop = $('#drop');
['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });
$('#file').addEventListener('change', e => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ''; });
function readFile(f) { const r = new FileReader(); r.onload = () => { $('#paste').value = r.result; $('#impResult').className = 'result'; $('#impResult').textContent = `Loaded ${f.name}.`; $('#doImport').click(); }; r.readAsText(f); } // picking a file imports it straight away

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
// Amazon sometimes sends titles with HTML codes left in ("Quick &amp; Easy"); turn them back into characters
const unent = s => String(s ?? '').replace(/&(?:(amp)|(lt)|(gt)|(quot)|(#39|apos)|#(\d+)|#x([0-9a-f]+));/gi, (m, a, l, g, q, ap, d, x) => a ? '&' : l ? '<' : g ? '>' : q ? '"' : ap ? "'" : String.fromCodePoint(d ? +d : parseInt(x, 16)));
const fixEntities = () => { for (const b of S.books) { if (/&#?\w+;/.test(b.title)) b.title = unent(b.title); if (/&#?\w+;/.test(b.author)) b.author = unent(b.author); } };
const cleanAuthor = a => {
  if (!a) return '';
  if (Array.isArray(a)) a = a[0] || '';
  if (typeof a === 'object') a = a.name || a.author || '';
  a = String(a).split(/\s*[:;]\s*/).filter(Boolean)[0] || '';
  a = a.trim();
  const parts = a.split(',');
  if (parts.length === 2 && parts[1].trim()) a = parts[1].trim() + ' ' + parts[0].trim();
  return a.replace(/\s+/g, ' ');
};
const toDate = v => {
  if (v == null || v === '') return '';
  if (typeof v === 'number' || /^\d{10,13}$/.test(v)) { const n = +v; const d = new Date(n < 1e12 ? n * 1000 : n); return isNaN(d) ? '' : d.toISOString().slice(0,10); }
  const s = String(v).trim().replace(/\//g, '-');
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) { const [y,m,d] = s.split(/[-T ]/); return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; }
  const d = new Date(v); return isNaN(d) ? '' : d.toISOString().slice(0,10);
};
const toNum = v => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
const mapSource = (origin, res) => {
  const o = String(origin || '').toUpperCase(), r = String(res || '').toUpperCase();
  if (r.includes('SAMPLE') || o.includes('SAMPLE')) return 'sample';
  if (o.includes('KINDLE_UNLIMITED') || o === 'KU') return 'ku';
  if (o.includes('PRIME')) return 'prime';
  if (o.includes('LEND') || o.includes('LIBRARY') || o.includes('RENT') || o.includes('SHARE')) return 'other';
  if (o.includes('FREE')) return 'free';
  return 'purchase';
};

function fromKindle(items) {
  return items.map(b => {
    const p = b.percentageRead ?? b.percentRead ?? b.readingProgress;
    const progress = p == null ? null : Math.max(0, Math.min(100, +p <= 1 && +p > 0 && !Number.isInteger(+p) ? +p * 100 : +p));
    return {
      asin: b.asin || '', title: unent(b.title || '').trim(), author: unent(cleanAuthor(b.authors || b.author)),
      progress, status: statusFromProgress(progress), source: mapSource(b.originType || b.origin, b.resourceType),
      date: toDate(b.acquiredTime ?? b.acquiredDate ?? b.acquisitionDate ?? b.purchaseDate ?? ''),
    };
  }).filter(b => b.title);
}
function fromRows(rows, kind) {
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } for (const n of names) { const i = head.findIndex(h => h.includes(n)); if (i >= 0) return i; } return -1; };
  const c = {
    title: col('title', 'productname', 'product name', 'item name', 'name'),
    author: col('author', 'authors', 'contributor', 'creator'),
    asin: col('asin'), pages: col('number of pages', 'pages', 'page count'),
    price: col('price paid', 'ourprice', 'our price', 'unit price', 'price', 'item total', 'listprice'),
    date: col('date added', 'orderdate', 'order date', 'purchase date', 'acquired', 'date'),
    shelf: col('exclusive shelf', 'status', 'shelf'), progress: col('progress', 'percent'),
    rating: col('my rating', 'rating'), source: col('source', 'origin'),
    binding: col('binding'), cat: col('productcategory', 'product category', 'productgroup', 'product group', 'category'),
  };
  if (c.title < 0) throw new Error('No title column found. The first row must be column names.');
  const grKindle = $('#grKindleOnly').checked;
  const out = [];
  for (const r of rows.slice(1)) {
    const g = i => i >= 0 ? (r[i] ?? '').trim() : '';
    if (grKindle && c.binding >= 0 && !/kindle/i.test(g(c.binding))) continue;
    if (c.cat >= 0 && g(c.cat) && !/book|kindle|ebook|digital_text|abis_ebooks/i.test(g(c.cat))) continue;
    const title = g(c.title).replace(/^="?|"$/g, ''); if (!title) continue;
    const shelf = g(c.shelf).toLowerCase();
    let status = null;
    if (/to-read|unread|want|tbr|not started/.test(shelf)) status = 'unread';
    else if (/currently|reading|started/.test(shelf)) status = 'reading';
    else if (/abandon|dnf|gave up|did-not-finish/.test(shelf)) status = 'abandoned';
    else if (/^read$|finished|done|complete/.test(shelf)) status = 'finished';
    const progress = toNum(g(c.progress));
    if (!status && progress != null) status = statusFromProgress(progress);
    const rating = toNum(g(c.rating));
    const src = g(c.source);
    out.push({
      title, author: cleanAuthor(g(c.author)), asin: g(c.asin), pages: toNum(g(c.pages)) || null,
      price: toNum(g(c.price)), date: toDate(g(c.date)), status, progress: progress ?? (status === 'finished' ? 100 : status === 'unread' ? 0 : null),
      rating: rating ? Math.round(Math.min(5, rating)) : 0, source: src ? (['purchase','free','ku','prime','sample','other','device'].includes(src.toLowerCase()) ? src.toLowerCase() : mapSource(src)) : null,
      shelfSet: status != null,
    });
  }
  return out;
}
function parseInput(text) {
  text = text.trim();
  if (!text) throw new Error('Paste some data or choose a file first.');
  if (text[0] === '<') {
    const x = new DOMParser().parseFromString(text, 'text/xml');
    const xt = (el, n) => (el.getElementsByTagName(n)[0]?.textContent || '').trim();
    const metas = [...x.getElementsByTagName('meta_data')];
    if (!metas.length) throw new Error('That XML file has no Kindle books in it. Use KindleSyncMetadataCache.xml from the Kindle app.');
    const books = metas.filter(m => !/PDOC/i.test(xt(m, 'cde_contenttype'))).map(m => ({
      asin: xt(m, 'ASIN'), title: xt(m, 'title'), author: cleanAuthor(xt(m, 'author')),
      date: toDate(xt(m, 'purchase_date')), status: null, progress: null, source: null,
    })).filter(b => b.title);
    return {books, kind:'kindleapp'};
  }
  if (text[0] === '{' || text[0] === '[') {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j[0]?.asin !== undefined || j[0]?.percentageRead !== undefined ? {books: fromKindle(j), kind:'kindle'} : {books: j, kind:'backup'};
    if (j.items || j.itemsList) return {books: fromKindle(j.items || j.itemsList), kind:'kindle'};
    if (j.books) return {books: j.books, kind:'backup', settings: j.settings};
    throw new Error('That JSON does not look like a Kindle export or a backup.');
  }
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one book.');
  return {books: fromRows(rows), kind:'csv'};
}
const normTitle = t => String(t || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').split(/[:—]| - /)[0].replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]/g, '');
const surname = a => { const w = String(a || '').toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/); return w[w.length - 1] || ''; };

function merge(incoming, replace, kind, addNew = true) {
  if (replace) S.books = [];
  const hadBooks = S.books.length > 0, today = new Date().toISOString().slice(0,10);
  const byAsin = new Map(), byKey = new Map(), byTitle = new Map();
  const index = b => {
    if (b.asin) byAsin.set(b.asin.toUpperCase(), b);
    byKey.set(normTitle(b.title) + '|' + surname(b.author), b);
    const t = normTitle(b.title); byTitle.set(t, byTitle.has(t) && byTitle.get(t) !== b ? 'dup' : b);
  };
  S.books.forEach(index);
  let added = 0, updated = 0;
  for (const inc of incoming) {
    if (kind === 'backup') { const nb = {...inc, id: inc.id || uid()}; const m = (nb.asin && byAsin.get(nb.asin.toUpperCase())) || byKey.get(normTitle(nb.title) + '|' + surname(nb.author)); if (m) { Object.assign(m, nb, {id: m.id}); updated++; } else { S.books.push(nb); index(nb); added++; } continue; }
    let m = (inc.asin && byAsin.get(inc.asin.toUpperCase())) || byKey.get(normTitle(inc.title) + '|' + surname(inc.author));
    if (!m && (!inc.author || true)) { const t = byTitle.get(normTitle(inc.title)); if (t && t !== 'dup' && (!inc.author || !t.author || surname(t.author) === surname(inc.author))) m = t; }
    if (!m && !addNew) continue;
    if (m) {
      for (const f of ['asin','author','pages','date','isbn']) if ((m[f] == null || m[f] === '') && inc[f]) m[f] = inc[f];
      // Content & Devices files prices and purchase dates under its own Amazon ID, so that ID wins over another edition's
      if (inc.asinWins && inc.asin && m.asin && m.asin.toUpperCase() !== inc.asin.toUpperCase() && !byAsin.has(inc.asin.toUpperCase())) { m.asin = inc.asin; byAsin.set(inc.asin.toUpperCase(), m); }
      if ((m.price == null || m.price === '') && inc.price != null) m.price = inc.price;
      if (inc.source && (m.source == null || kind === 'kindle')) m.source = inc.source;
      if (inc.rating) m.rating = inc.rating;
      if (!m.lock) {
        if (inc.progress != null && kind === 'kindle') m.progress = inc.progress;
        if (inc.status) m.status = inc.status;
        if (kind === 'goodreads' && inc.progress != null && (inc.status !== 'reading' || !m.progress)) m.progress = inc.progress;
      }
      updated++;
    } else {
      const b = {
        id: uid(), title: inc.title, author: inc.author || '', asin: inc.asin || '', pages: inc.pages || null,
        price: inc.price ?? null, date: inc.date || '', status: inc.status || 'unread', progress: inc.progress ?? 0,
        rating: inc.rating || 0, source: inc.source || 'purchase',
      };
      // A Kindle book that shows up after the first import was almost certainly just bought
      if (!b.date && hadBooks && kind === 'kindle') { b.date = today; b.dateEst = true; }
      S.books.push(b); index(b); added++;
    }
  }
  return {added, updated};
}
$('#doImport').onclick = () => {
  const res = $('#impResult');
  try {
    const {books, kind, settings} = parseInput($('#paste').value);
    if (!books.length) throw new Error('No books found in that data.');
    const wasDemo = S.demo;
    leaveDemo(true);
    if (settings && kind === 'backup') S.settings = {...DEFAULTS, ...settings};
    const {added, updated} = merge(books, $('#replace').checked || wasDemo, kind);
    $('#paste').value = '';
    $('#dlgImport').close();
    renderAll(); scheduleSave();
    toast(`Imported: ${added} added, ${updated} updated`);
  } catch (e) { res.className = 'result err'; res.textContent = e.message || String(e); }
};

// ---------- spreadsheet export (.xlsx, built in the page: header row frozen, filter/sort arrows on every column) ----------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) { // files: [{name, data: Uint8Array}] -> Uint8Array, uncompressed zip
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + sz;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
const xEsc = v => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - m - 1) / 26; } return s; };
function buildXlsx(header, rows, widths) { // cell: string | number | {date:'yyyy-mm-dd'} | {money:n} | null
  const serial = d => (Date.UTC(+d.slice(0,4), +d.slice(5,7) - 1, +d.slice(8,10)) - Date.UTC(1899, 11, 30)) / 864e5;
  const cell = (v, r, c) => {
    const ref = colName(c) + r;
    if (v == null || v === '') return '';
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (v.date) return `<c r="${ref}" s="2"><v>${serial(v.date)}</v></c>`;
    if (v.money != null) return `<c r="${ref}" s="3"><v>${v.money}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xEsc(v)}</t></is></c>`;
  };
  const last = colName(header.length - 1) + (rows.length + 1);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>
<row r="1">${header.map((h, c) => `<c r="${colName(c)}1" t="inlineStr" s="1"><is><t>${xEsc(h)}</t></is></c>`).join('')}</row>
${rows.map((row, i) => `<row r="${i + 2}">${row.map((v, c) => cell(v, i + 2, c)).join('')}</row>`).join('\n')}
</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  const cur = (() => { try { return new Intl.NumberFormat(undefined, {style:'currency', currency:S.settings.currency}).formatToParts(1).find(p => p.type === 'currency').value; } catch { return '$'; } })();
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="&quot;${xEsc(cur)}&quot;#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E9E4"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const enc = new TextEncoder(), X = s => enc.encode(s);
  return zipStore([
    {name: '[Content_Types].xml', data: X(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`)},
    {name: '_rels/.rels', data: X(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)},
    {name: 'xl/workbook.xml', data: X(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Library" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Library!$A$1:$${last.replace(/(\d+)$/, '$$$1')}</definedName></definedNames></workbook>`)},
    {name: 'xl/_rels/workbook.xml.rels', data: X(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)},
    {name: 'xl/styles.xml', data: X(styles)},
    {name: 'xl/worksheets/sheet1.xml', data: X(sheet)},
  ]);
}
const SOURCE_NAME = {purchase:'Bought', device:'Came with my Kindle', free:'Free', ku:'Kindle Unlimited', prime:'Prime Reading', sample:'Sample', shared:'Family Library', other:'Borrowed / other'};
function libraryXlsx() {
  const header = ['Title', 'Author', 'Status', 'Progress %', 'Pages', 'Price paid', 'Kindle price today', 'Purchase date', 'How you got it', 'Genre', 'Second genre', 'Tags', 'Rating', 'Counted in totals', 'ASIN'];
  const rows = [...S.books].sort((a, b) => (a.title || '').localeCompare(b.title || '')).map(b => [
    b.title || '', b.author || '', STATUS[b.status] || b.status || '', Math.round(b.progress || 0), b.pages > 0 ? b.pages : null,
    hasPaid(b) ? {money: +b.price} : null, b.kp != null ? {money: b.kp} : null, /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? {date: b.date} : null,
    b.returned ? 'Returned' : SOURCE_NAME[b.source] || b.source || '', b.genre && b.genre !== 'unknown' ? genreLabel(b) + (b.genreSub && b.genreSub !== genreLabel(b) ? ' › ' + b.genreSub : '') : '', GENRES[b.genre2] || '', (b.tags || []).join(', '), b.rating || null, counted(b) ? 'Yes' : 'No', b.asin || '',
  ]);
  return buildXlsx(header, rows, [46, 24, 11, 11, 8, 11, 13, 14, 18, 20, 16, 40, 8, 10, 13]);
}
async function saveFile(name, data, mime, okMsg) {
  try { const u = URL.createObjectURL(new Blob([data], {type: mime})); const l = document.createElement('a'); l.href = u; l.download = name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); toast(okMsg); }
  catch { toast('Downloads are not available here'); }
}
$('#btnXlsx').onclick = () => {
  if (!S.books.length) { toast('No books to export yet'); return; }
  saveFile(`kindle-library-${new Date().toISOString().slice(0,10)}.xlsx`, libraryXlsx(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Spreadsheet downloaded');
};

// ---------- live sync ----------
// A sync source is either the Tampermonkey script itself (KLC_CORE, when this page is drawn by the script on goodreads.com)
// or the script's bridge on the website (it answers window messages). Without either, the page works from file imports only.
const kpWaiters = {}; let kpSeq = 0, kpRunning = false, lastSyncMsg = '';
let storeReady = Promise.resolve(), syncing = false, syncOn = false, bridgeWaiters = null;
const hasCore = typeof KLC_CORE !== 'undefined';
const postBridge = m => window.postMessage(Object.assign({klc: 1}, m), location.origin === 'null' ? '*' : location.origin);
function setSync(msg, kind) { const el = $('#sync'); const sc = document.getElementById('syncCard'); el.hidden = !!(sc && !sc.hidden); el.className = 'store ' + ({db: 'st-ok', local: 'st-bad'}[kind] || 'st-wait'); /* done, a problem, or still going */ el.querySelector('span').textContent = msg; }

function enableSync() {
  if (syncOn) return;
  syncOn = true;
  $('#btnSync').hidden = false;
  $('#bannerImport').textContent = 'Sync now';
  const p = $('#demoBanner p'); if (p) p.innerHTML = '<strong>This is an example library.</strong> Your first sync replaces it with your Kindle library and Goodreads shelves.';
  setSync('Connected to the sync script', 'db');
  wizConnected();
  renderScriptSect();
  if (!document.getElementById('dlgWiz')?.open && !document.getElementById('dlgForce')?.open) runSync(false); // no syncing with an out-of-date script // mid-setup, the last setup step starts the sync once they've signed in
}
window.addEventListener('message', e => {
  const d = e.data;
  if (!d || d.klc !== 1 || (e.origin && e.origin !== location.origin && location.origin !== 'null')) return;
  if (d.type === 'ready') { checkScriptVersion(d.version); enableSync(); }
  else if (d.type === 'progress') { syncProgress(d.msg); if (bridgeWaiters) bridgeWaiters.poke(); }
  else if (d.type === 'binfoResult' && kpWaiters[d.id]) { const w = kpWaiters[d.id]; delete kpWaiters[d.id]; try { w(JSON.parse(d.data)); } catch { w(null); } }
  else if (d.type === 'result' && bridgeWaiters) { const w = bridgeWaiters; bridgeWaiters = null; try { w.resolve(JSON.parse(d.data)); } catch (err) { w.reject(err); } }
});
// ---------- phone sync bookmark: amazon.com opens this page with #bm and hands over what it read there ----------
// The bookmark is tiny (phone browsers cut off long bookmarks): it loads bm.js from this site, which does the work on amazon.com
// The bookmark checks the signed release before running anything: it fetches release.json, checks its signature with the
// public key below, then loads bm.js with the signed fingerprint so the browser refuses any other file.
const SIGN_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEy1ISS5hsqAzzd9MIDHiLbPEZm3j2D+m31Beqg+ylcGEk6q8Mh6iibJJ5G5dH0GdUVwClChtOexlh5jd7fy9h2g==';
const bookmarkletCode = () => `javascript:(async()=>{const S='${location.origin}/',K='${SIGN_KEY}',a=u=>Uint8Array.from(atob(u),c=>c.charCodeAt(0)),E=()=>alert('Shelf sync stopped: its code could not be checked as genuine, so nothing was run.');try{const r=await(await fetch(S+'release.json?'+Date.now())).json(),c=crypto.subtle,k=await c.importKey('spki',a(K),{name:'ECDSA',namedCurve:'P-256'},0,['verify']);if(!await c.verify({name:'ECDSA',hash:'SHA-256'},k,a(r.sig),new TextEncoder().encode(r.text)))throw 0;const m=JSON.parse(r.text),s=document.createElement('script');s.src=S+'bm.js?v='+m.version;s.integrity=m.files['bm.js'];s.crossOrigin='anonymous';s.onerror=E;document.body.appendChild(s)}catch(e){E()}})()`;
function initPhoneSync() {
  if (location.hash !== '#bm' || !window.opener) return;
  const AMZ = /^https:\/\/www\.amazon\.(com|co\.uk|ca|com\.au)$/;
  window.addEventListener('message', async e => {
    const d = e.data;
    if (!d || d.klc !== 1 || d.type !== 'bm-data' || !AMZ.test(e.origin)) return;
    let data; try { data = JSON.parse(d.data); } catch { return; }
    await storeReady;
    const n = applyPhoneSync(data);
    try { e.source.postMessage({klc: 1, type: 'bm-done', books: n}, e.origin); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
  });
  window.opener.postMessage({klc: 1, type: 'bm-ready'}, '*'); // just "I'm here"; the data only comes from Amazon's own page
}
// The same book can sit in the library twice: once under the Kindle reader's ID (from a computer sync) and once under
// Content & Devices' ID (from the phone, brought over by Google Drive). Keep the Content & Devices copy and fold the other
// into it: anything only the other copy has comes across, edits made by hand win, and the further reading progress wins.
function foldDuplicates(ownedItems) {
  const cd = new Set((ownedItems || []).map(i => String(i.asin || '').toUpperCase()).filter(Boolean));
  if (!cd.size) return 0;
  const key = b => normTitle(b.title) + '|' + surname(b.author);
  const keep = new Map();
  for (const b of S.books) if (b.asin && cd.has(b.asin.toUpperCase())) keep.set(key(b), b);
  let n = 0;
  S.books = S.books.filter(d => {
    if (d.asin && cd.has(d.asin.toUpperCase())) return true;
    const k = keep.get(key(d)); if (!k || k === d) return true;
    for (const f of Object.keys(d)) if (f !== 'id' && f !== 'asin' && (k[f] == null || k[f] === '' || (Array.isArray(k[f]) && !k[f].length))) k[f] = d[f];
    for (const f of Object.keys(d)) if (/Src$/.test(f) && d[f] === 'manual' && k[f] !== 'manual') { const base = f.slice(0, -3); k[f] = 'manual'; if (base in d) k[base] = d[base]; }
    for (const f of ['dateManual', 'sourceManual']) if (d[f] && !k[f]) { k[f] = true; k[f === 'dateManual' ? 'date' : 'source'] = d[f === 'dateManual' ? 'date' : 'source']; }
    if (d.priceSrc !== 'order' && hasPaid(d) && !(k.priceSrc === 'order')) k.price = d.price;
    if ((d.progress || 0) > (k.progress || 0) || (d.lock && !k.lock)) { k.progress = d.progress; k.status = d.status; }
    if (d.lock) k.lock = true;
    n++; return false;
  });
  return n;
}
function applyPhoneSync(data) {
  const items = data.owned?.items || [];
  if (!items.length) return 0;
  leaveDemo(true);
  merge(fromKindle(items).map(x => ({...x, asinWins: true})), false, 'kindle');
  foldDuplicates(items);
  const dated = applyOwnership(items);
  let priced = 0;
  for (const b of S.books) {
    const v = b.asin && data.prices && data.prices[b.asin];
    if (typeof v === 'number' && !hasPaid(b)) { b.price = v; b.priceSrc = 'order'; priced++; }
  }
  const now = Date.now(); let det = 0;
  for (const b of S.books) { const inf = b.asin && data.info && data.info[b.asin]; if (inf) { applyBookInfo(b, inf, now); det++; } }
  renderAll(); scheduleSave();
  lsSet1('klc-bm-last', String(now));
  const when = new Date(now).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  setSync(`Synced ${when} with the sync bookmark · ${items.length} books · ${dated} purchase dates${priced ? ` · ${priced} prices` : ''} · details for ${det}`, 'db');
  toast(`Synced ${fmtInt(items.length)} books from Amazon`);
  return items.length;
}
function startSync() {
  if (MOBILE && S.demo) { const p = $('#demoBanner p'); if (p) p.innerHTML = '<strong>This is an example library</strong> of public-domain classics so you can see how it works. Tap <b>Get started</b> to bring in your own books from Amazon, Google Drive or a file.'; const bi = $('#bannerImport'); if (bi) bi.textContent = 'Get started'; }
  initPhoneSync();
  initDrive();
  storeReady.then(() => { if (!S.demo && markExtras()) { renderAll(); scheduleSave(); } setTimeout(showNotice, 1800); }); // fix up libraries synced before extras were spotted by title
  if (hasCore) { enableSync(); return; }
  postBridge({type: 'hello'});
  if (location.protocol === 'file:') return;
  const resume = ssGet('klc-wiz');
  storeReady.then(() => setTimeout(() => {
    if (syncOn) return;
    // First visit (still on the example) or coming back mid-setup: walk them through it
    if (resume || (S.demo && !lsFlag('klc-wiz-skip'))) { openWizard(resume || 'welcome'); return; }
    // Has their own books but no script answered: say so, with a way into setup (unless they sync with the bookmark)
    const el = $('#sync'); el.hidden = false; el.className = 'store st-bad';
    let bmLast = 0; try { bmLast = +(localStorage.getItem('klc-bm-last') || 0); } catch {}
    if (bmLast) { el.className = 'store st-ok'; el.querySelector('span').textContent = `Last synced with the sync bookmark ${new Date(bmLast).toLocaleDateString([], {month: 'short', day: 'numeric'})}`; renderScriptSect(); return; }
    el.querySelector('span').innerHTML = 'Sync script not detected, so prices, pages and genres are guesses. <a href="#" id="syncHelp" style="color:inherit">Set up sync</a>';
    $('#syncHelp').onclick = e => { e.preventDefault(); openWizard('welcome'); };
    renderScriptSect();
  }, resume === 'check' ? 0 : 1500));
  setInterval(checkPageUpdate, 30 * 60000); setTimeout(checkPageUpdate, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') return; if (document.getElementById('dlgForce')?.open && ssGet('klc-updating')) { location.reload(); return; } if (ssGet('klc-updating')) { ssSet('klc-updating', ''); pendingReload = true; } tryReload(); });
  if (ssGet('klc-updated-from')) { ssSet('klc-updated-from', ''); lsSet1('klc-unseen', '1'); setTimeout(() => toast(`Updated to version ${verLabel(LATEST_SCRIPT)}. Settings shows what's new.`), 800); }
  refreshDot();
}
function bridgeSync(force, paid) {
  return new Promise((resolve, reject) => {
    // Gives up only after 2 minutes with no word from the script; a long sync that keeps reporting progress is fine
    let t = 0;
    const poke = () => { clearTimeout(t); t = setTimeout(() => { if (bridgeWaiters) { bridgeWaiters = null; reject(new Error('The sync script stopped answering. Reload the page.')); } }, 120000); };
    bridgeWaiters = {resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); }, poke};
    postBridge({type: 'sync', force, paid});
    poke();
  });
}

const grDate = s => { const d = s ? new Date(s) : null; return d && !isNaN(d) ? d.toISOString().slice(0,10) : ''; };
function normGoodreads(list) {
  return (list || []).map(b => ({
    title: String(b.title || '').trim(), author: cleanAuthor(b.author), isbn: b.isbn || '',
    pages: toNum(b.pages) || null, rating: Math.round(Math.min(5, toNum(b.rating) || 0)),
    date: grDate(b.dateAdded), status: b.status,
    progress: b.status === 'finished' ? 100 : b.status === 'unread' ? 0 : null, source: null,
  })).filter(b => b.title);
}

const DEVICE_EXTRA = /dictionar|diccionario|dictionnaire|dicion[aá]rio|w[oö]rterbuch|woordenboek|vocabolario|shabd|kosh|lingvo|词典|辞典|辞泉|daijisen|zingarelli|priberam|duden|munjid|user'?s guide|benutzerhandbuch|gu[ií]a del usuario|guide d.utilisation|gebruikershandleiding|guia do usu[aá]rio|guida all.uso|用户指南|yuza gaido/i;
const ORIGIN = {purchase:'purchase', sharing:'shared', kindleunlimited:'ku', prime:'prime', primereading:'prime', sample:'sample', publiclibrarylending:'other', personallending:'other', rental:'other', koll:'other', freetrial:'free', comicsunlimited:'ku'};
// Real purchase dates from Amazon replace missing or estimated ones; Kindle's "Mark as read" marks a book finished
// Dictionaries and user guides come free with a Kindle, even when Amazon's list files them with an order: they're Kindle
// extras (not counted unless Settings says so), unless a price was really paid for one
const isExtra = b => !b.sourceManual && DEVICE_EXTRA.test(b.title || '') && !(hasPaid(b) && +b.price > 0);
function markExtras() { let n = 0; for (const b of S.books) if (b.source === 'purchase' && isExtra(b)) { b.source = 'device'; n++; } return n; }
function applyOwnership(items) {
  if (!items || !items.length) return 0;
  const byAsin = new Map(items.map(i => [String(i.asin || '').toUpperCase(), i]));
  // Books Amazon listed before but no longer does were returned (or removed): kept in the list, left out of the totals.
  // Only from a list that looks complete, so a short answer from Amazon can't mark half the library returned.
  const seen = S.books.filter(b => b.asin && (b.cdSeen || (b.dateEst === false && !b.dateManual)));
  const complete = items.length >= seen.length * .8;
  let n = 0;
  for (const b of S.books) {
    const o = b.asin && byAsin.get(b.asin.toUpperCase());
    if (!o) { if (complete && seen.includes(b) && !b.returned) b.returned = true; continue; }
    b.cdSeen = true; if (b.returned) delete b.returned;
    const d = o.acquiredTime ? new Date(+o.acquiredTime).toISOString().slice(0,10) : toDate(o.acquiredDate);
    if (d && (!b.date || b.dateEst || b.date !== d) && !b.dateManual) { b.date = d; b.dateEst = false; }
    if (d) n++;
    // How the book was obtained, from Amazon's own record (a source you picked by hand wins)
    const src = ORIGIN[String(o.originType || '').toLowerCase()];
    if (src && !b.sourceManual) b.source = src;
    // A "purchase" with no order behind it wasn't bought: dictionaries and user guides come with the Kindle, anything else was free
    if (src === 'purchase' && !o.orderDetailURL && !o.orderId && !b.sourceManual && !(hasPaid(b) && b.priceSrc !== 'order')) b.source = DEVICE_EXTRA.test(b.title) ? 'device' : 'free';
    if (/^READ$/i.test(o.readStatus || '') && !b.lock && b.status !== 'finished') { b.status = 'finished'; b.progress = 100; }
  }
  markExtras();
  return n;
}
async function runSync(force) {
  if (syncing || !syncOn) return;
  syncing = true; $('#btnSync').disabled = true;
  try {
    await storeReady;
    setSync('Syncing…'); cardStart();
    const paid = S.books.filter(b => b.asin && hasPaid(b)).map(b => b.asin); // already priced: the script never looks these up again
    const data = hasCore ? await KLC_CORE.sync(force, msg => syncProgress(msg), paid) : await bridgeSync(force, paid);
    const gr = normGoodreads(data.goodreads);
    // Like the phone bookmark: Content & Devices is the main list, because prices paid and purchase dates are filed under its
    // Amazon IDs. The Kindle reader's list then adds reading progress, and any book bought since Content & Devices was last read.
    const owned = data.owned?.items || [], kList = data.kindle?.items || [];
    let kItems = owned.length ? owned : kList;
    // The Kindle reader (read.amazon.com) has its own sign-in. If it said no but Content & Devices answered, build the library from that list.
    const fromOwned = owned.length > 0, noProgress = fromOwned && !kList.length;
    if (!gr.length && !kItems.length) { setSync([data.grErr, data.kErr].filter(Boolean).join(' · ') || 'Nothing to sync yet.', 'local'); cardResult(data, 0, 0, 0, 0); return; }
    leaveDemo(true);
    if (kItems.length) merge(fromKindle(kItems).map(x => fromOwned ? {...x, asinWins: true} : x), false, 'kindle');
    if (fromOwned) foldDuplicates(owned);
    // Reading progress, plus any book Content & Devices hasn't listed yet (it's re-read once a day). A book already here under
    // its Content & Devices ID is matched by title, so it isn't added twice.
    if (fromOwned && kList.length) merge(fromKindle(kList), false, 'kindle');
    const res = merge(gr, false, 'goodreads', !kItems.length || S.settings.grAll);
    const dated = applyOwnership(data.owned?.items);
    let priced = 0;
    if (data.prices) for (const b of S.books) {
      const v = b.asin && data.prices[b.asin];
      if (typeof v === 'number' && !hasPaid(b)) { b.price = v; b.priceSrc = 'order'; priced++; } // once a price paid is set it is locked
    }
    renderAll(); scheduleSave();
    const when = new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
    const grTxt = data.grErr ? `Goodreads failed: ${data.grErr}` : `Goodreads ${gr.length} books, ${res.updated} matched`;
    const oTxt = (data.oErr ? ` · Purchase dates failed: ${data.oErr}` : dated ? ` · ${dated} purchase dates` : '') + (priced ? ` · ${priced} prices` : '');
    const kTxt = data.kErr && !kItems.length ? `Kindle failed: ${data.kErr}` : kItems.length ? `Kindle ${kItems.length} books` + (data.kErr ? ' (older copy: ' + data.kErr + ')' : '') : 'Kindle not synced';
    lastSyncMsg = `Synced ${when} · ${grTxt} · ${kTxt}${oTxt}`;
    setSync(lastSyncMsg, data.grErr || data.kErr || data.oErr ? 'local' : 'db');
    cardResult(data, gr.length, kItems.length, dated, priced, noProgress);
    setTimeout(lookupBookInfo, 500);
  } catch (e) {
    setSync(e.message || String(e), 'local'); cardError('sync', e.message || String(e));
  } finally { syncing = false; $('#btnSync').disabled = false; tryReload(); }
}

// ---------- facts from each book's Amazon page: genre, page count, today's price ----------
// Each book's page is read once for genre and pages; today's price (only for books without a price paid) is rechecked monthly.
function infoFetch(asins) {
  if (hasCore) return KLC_CORE.bookInfo(asins);
  return new Promise(resolve => {
    const id = ++kpSeq; kpWaiters[id] = resolve;
    postBridge({type: 'binfo', id, asins});
    setTimeout(() => { if (kpWaiters[id]) { delete kpWaiters[id]; resolve(null); } }, 120000);
  });
}
// What one look at a book's Amazon page tells us: today's price, page count, genre, second genre and tags
function applyBookInfo(b, inf, now) {
  let priced = false;
  if (!hasPaid(b) && inf.price != null) { b.kp = inf.price; priced = true; }
  b.kpTime = now;
  if (!(b.pages > 0) && inf.pages) { b.pages = inf.pages; b.pagesSrc = 'amazon'; }
  if (b.genreSrc !== 'manual') { const g = amazonGenre(inf); if (g) { b.genre = g.key; b.genreName = g.name; b.genreSub = g.sub; b.genreSrc = 'amazon'; } }
  b.tags = amazonTags(inf);
  if (b.genre2Src !== 'manual') b.genre2 = secondGenre(b.tags, b.genre);
  b.genreV = GENRE_V;
  b.infoTime = now;
  return priced;
}
async function lookupBookInfo() {
  if (kpRunning || !syncOn || S.demo) return;
  const MONTH = 30 * 864e5, now = Date.now();
  const needsPrice = b => !hasPaid(b) && b.source !== 'free' && b.source !== 'device' && b.source !== 'sample' && (!b.kpTime || now - b.kpTime > MONTH);
  const todo = S.books.filter(b => b.asin && (!b.infoTime || needsPrice(b) || needsGenre(b)))
    .sort((a, b) => (a.status === 'unread' ? 0 : 1) - (b.status === 'unread' ? 0 : 1) || (counted(a) ? 0 : 1) - (counted(b) ? 0 : 1));
  if (!todo.length) { genreStatus(''); stage('details', 'ok', 'up to date'); cardMaybeDone(); return; }
  kpRunning = true;
  let done = 0, found = 0;
  try {
    for (let i = 0; i < todo.length; i += 8) {
      const batch = todo.slice(i, i + 8);
      const mins = Math.ceil((todo.length - done) * 0.95 / 60);
      const eta = mins > 1 ? `about ${mins} minutes left` : 'almost done';
      setSync(`${lastSyncMsg} · Reading book details from Amazon (genre, pages, price)… ${done} of ${todo.length}, ${eta}`);
      stage('details', 'run', `${fmtInt(done)} of ${fmtInt(todo.length)} · ${mins > 1 ? mins + ' min' : 'almost done'}`, done / todo.length);
      if (S.settings.spineMode === 'genre') genreStatus(`Still reading genres from Amazon: ${done} of ${todo.length} books, ${eta}. Big libraries take a while the first time (about a second per book). Gray spines fill in as it goes, you can keep using the page, and if you leave it picks up where it stopped next visit.`);
      const res = await infoFetch(batch.map(b => b.asin));
      if (!res) break;
      for (const b of batch) {
        const inf = res.info[b.asin]; if (!inf) continue;
        if (applyBookInfo(b, inf, now)) found++;
        done++;
      }
      renderStats(); renderShelf(); scheduleSave();
      if (res.blocked) { setSync(`${lastSyncMsg} · Amazon paused lookups after ${done}; the rest continue next visit`, 'wait'); stage('details', 'err', `${fmtInt(done)} of ${fmtInt(todo.length)}`, done / todo.length); cardError('details', 'Amazon asked us to slow down. The rest of the book details fill in on your next visit.', true); return; }
    }
    genreStatus('');
    setSync(`${lastSyncMsg}${done ? ` · details for ${done} books` : ''}`, 'db');
    stage('details', 'ok', nb(done, 'book')); cardMaybeDone();
  } finally { kpRunning = false; tryReload(); }
}

// ---------- tell people when their sync script is behind the site ----------
const LATEST_SCRIPT = '2.1.0.0.8';
// Beta builds carry a fifth number, the beta count: 2.0.0.0.1 is shown as "2.0 beta 1" (the live build it's heading toward, then which beta)
const verLabel = v => { const p = String(v || '').split('.'); if (p.length < 5) return String(v || ''); const b = p.pop(); while (p.length > 2 && p[p.length - 1] === '0') p.pop(); return p.join('.') + ' beta ' + b; };
const SCRIPT_URL = 'https://raw.githubusercontent.com/Kirbeeman/bookshelfcalc/main/kindle-library-calculator.user.js';
const verLess = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
let scriptVer = '';
// The oldest sync script this page works with. Raise it only when a release changes the script itself;
// page-only releases leave it alone, so people aren't stopped for updates that don't touch their script.
const REQUIRED_SCRIPT = '2.1.0.0.2'; // filled in by build.py: the version where the script's code last changed
function renderVerLine() {
  const el = document.getElementById('verLine'); if (!el) return;
  const sv = scriptVer ? 'v' + verLabel(scriptVer) + (verLess(scriptVer, REQUIRED_SCRIPT) ? ' (update needed)' : '') : 'not installed';
  el.textContent = 'App v' + verLabel(LATEST_SCRIPT) + ' · Sync script ' + sv;
}
function checkScriptVersion(v) { if (v && scriptVer && verLess(v, scriptVer)) return; scriptVer = v || ''; // two copies installed: go by the newer one
  renderScriptSect(); renderVerLine(); refreshDot(); if (v && verLess(v, REQUIRED_SCRIPT)) forceUpdate(v); else if (v && document.getElementById('dlgForce')?.open) { document.getElementById('dlgForce').close(); ssSet('klc-updating', ''); } }
// An out-of-date script blocks the page until it's updated: no close button, Esc does nothing, clicks outside do nothing
function forceUpdate(v) {
  let d = $('#dlgForce');
  if (!d) {
    d = document.createElement('dialog'); d.id = 'dlgForce'; d.className = 'wizdlg forcedlg';
    d.addEventListener('cancel', e => e.preventDefault());
    document.body.append(d);
  }
  const back = ssGet('klc-updating');
  d.innerHTML = `<div class="dlg wiz">
    <div class="forceicon" aria-hidden="true">⟳</div>
    <h2>${back ? 'Hold up, wait a minute…' : 'Update needed'}</h2>
    <p>${back ? `This page still sees version <b>${esc(verLabel(v))}</b>. In the Tampermonkey tab that opened, press <b>Update</b>, then come back here. If Tampermonkey now lists two Shelf of Shame scripts, delete the older one.`
      : `Your sync script is version <b>${esc(verLabel(v))}</b>, and this page needs <b>${verLabel(REQUIRED_SCRIPT)}</b> or newer to sync correctly. It takes about ten seconds and keeps all your books and settings.`}</p>
    <ol class="wlist"><li>Click <b>Update script</b>. Tampermonkey opens in a new tab.</li><li>Press <b>Update</b> there.</li><li>Come back to this tab. It reloads by itself.</li></ol>
    <div class="row" style="justify-content:center;gap:10px"><a class="btn primary" href="${SCRIPT_URL}" target="_blank" rel="noopener" id="forceGo">Update script</a>${back ? '<button type="button" class="btn" id="forceRe">Check again</button>' : ''}</div>
    <details class="news"><summary>Tampermonkey didn't open?</summary><p>Click the Tampermonkey icon in your browser's toolbar → <b>Utilities</b> → <b>Check for userscript updates</b>, then reload this page.</p></details>
  </div>`;
  $('#forceGo').onclick = () => ssSet('klc-updating', '1');
  const re = $('#forceRe'); if (re) re.onclick = () => location.reload();
  if (!d.open) d.showModal();
}

// ---------- a one-time notice for a new version (looks like the update dialog and follows the theme) ----------
const NOTICE = 'signed-2.1';
const NOTICE_ICONS = {
  thanks: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  safe: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>'
};
function showNotice() {
  let seen = ''; try { seen = localStorage.getItem('klc-notice') || ''; } catch { return; }
  if (seen === NOTICE) return;
  // new people (still on the example) have nothing to be thanked for yet; they just don't see it
  if (S.demo) { lsSet1('klc-notice', NOTICE); return; }
  // never on top of the update dialog or the setup walk-through: wait until they're closed
  if (document.querySelector('dialog[open]')) { setTimeout(showNotice, 3000); return; }
  const d = document.createElement('dialog'); d.id = 'dlgNotice'; d.className = 'wizdlg forcedlg';
  const done = () => { lsSet1('klc-notice', NOTICE); d.close(); d.remove(); };
  d.addEventListener('cancel', e => { e.preventDefault(); done(); });
  document.body.append(d);
  const page = n => {
    const dots = `<div class="pp">${[1, 2].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div><div class="count">PAGE ${n} OF 2</div>`;
    d.innerHTML = `<div class="dlg wiz">` + (n === 1 ? `${dots}
      <div class="forceicon" aria-hidden="true">${NOTICE_ICONS.thanks}</div>
      <h2>Thank you</h2>
      <p>Thanks for using the Shelf of Shame, and for sticking with it through every update. Your ideas, bug reports and patience are what keep it getting better, and I'm grateful for every one of you.</p>
      <div class="row wnav"><span></span><button type="button" class="btn primary" id="noticeNext">Next</button></div>`
      : `${dots}
      <div class="forceicon" aria-hidden="true">${NOTICE_ICONS.safe}</div>
      <h2>Keeping your data safe</h2>
      <p>I'm committed to keeping the Shelf of Shame safe and secure. The sync reads your books, prices and order dates from Amazon and Goodreads, and that should only ever end up with you.</p>
      <p>So this version adds a new layer of protection: the sync bookmark and the sync script now check that their code is genuine, signed by me, before they run. Even if someone broke into the website or its code, they couldn't use it to get at your data.</p>
      <div class="wwarn">There may be a few hiccups while this settles in. If something looks off, reload the page or sync again. ${MOBILE ? 'Sync from your phone? Set up the bookmark once more: <b>Settings › Set up the bookmark</b>.' : ''}</div>
      <p>The added layer of security is worth it. Thanks for bearing with me.<br><b>Daniel</b></p>
      <div class="row wnav"><button type="button" class="btn" id="noticeBack">Back</button><button type="button" class="btn primary" id="noticeDone">Got it</button></div>`) + `</div>`;
    const go = $('#noticeNext'), bk = $('#noticeBack'), ok = $('#noticeDone');
    if (go) go.onclick = () => page(2); if (bk) bk.onclick = () => page(1); if (ok) ok.onclick = done;
    (go || ok).focus();
  };
  page(1); d.showModal(); $('#noticeNext').focus();
}

// ---------- small storage helpers (storage can be blocked; nothing here may throw) ----------
const ssGet = k => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } };
const ssSet = (k, v) => { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch {} };
const lsFlag = k => { try { return !!localStorage.getItem(k); } catch { return false; } };
const lsSet1 = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };

// ---------- what's new (shown in Settings) ----------
const CHANGES = [
  ['2.1.0.0.8', ['Dictionaries and user guides that came with your Kindle are no longer counted as bought books, even when Amazon files them with an order', 'Books you returned to Amazon are marked Returned and left out of the totals (they come back by themselves if they show up in your Amazon library again)']],
  ['2.1.0.0.7', ['Books added per year: the small arrows on cut-off bars are gone (they looked like 1s); the break mark still shows a bar is cut off', 'The reading-status rings and table show 99.5% instead of rounding to 100%']],
  ['2.1.0.0.6', ['The status dots under the title use the same colors in every theme: green when saved or synced, yellow while waiting or syncing, red when something went wrong']],
  ['2.1.0.0.5', ['Unread shares near 0% or 100% show a decimal (99.5%) instead of rounding to 100% when you have read a few books', 'New wording when you have barely started your library, or not started it at all']],
  ['2.1.0.0.4', ['The full bookcase keeps room at the end of its last shelf for the bookend, plants and other decorations']],
  ['2.1.0.0.3', ['On a computer the bookcase is 3 shelves tall at most and holds up to 100 unread books, with thinner spines when it needs them; the rest are counted below it']],
  ['2.1.0.0.2', ['Signed code: the phone bookmark and the sync script now only run code signed with the Shelf of Shame key, so nobody else can change what runs in your Amazon account. Set up the bookmark once more, and update the sync script once']],
  ['2.1.0.0.1', ['Security: every page now tells your browser to run only the Shelf of Shame\'s own code and Google\'s sign-in, and to talk only to this site, Google Fonts and Google Drive', 'A getting-started guide for every device at /help']],
  ['2.0.0.0.16', ['Your oldest unread book is named first, as in "Moby-Dick has been waiting this long for you to read it"']],
  ['2.0.0.0.15', ['Fixed: the phone sync bookmark stopped with "Can\'t find variable: unHtml"']],
  ['2.0.0.0.14', ['The sync script cleans up titles and authors as it reads them from Amazon (no more &amp;). This one needs a script update']],
  ['2.0.0.0.13', ['Dictionaries and user guides that came with your Kindle are no longer counted as unread books worth $7.99 each (Settings can count them again)', 'A book Amazon lists as bought but with no order behind it counts as free instead of a guessed price', 'Titles show & instead of &amp;', 'Fruit theme: pop-ups like How this adds up are no longer hidden under the next panel']],
  ['2.0.0.0.12', ['On a computer, your library now comes from Amazon\'s Content & Devices list, like on a phone, so prices paid land on the right books. The Kindle reader still adds reading progress and brand-new books', 'A book that was in your library twice (once from the computer, once from the phone) becomes one again, keeping your edits']],
  ['2.0.0.0.11', ['iPads get the phone setup (the sync bookmark, Google Drive or a file) instead of being told to use a computer']],
  ['2.0.0.0.10', ['Until you pick a theme, the page starts in Fruit on iPhone, iPad and Mac, and in Default everywhere else. A theme you pick always sticks']],
  ['2.0.0.0.9', ['New theme in Settings: Fruit. Frosted glass panels over a soft, colorful background, rounded pill buttons and bright colors. It follows your device\'s light or dark setting']],
  ['2.0.0.0.8', ['Behind-the-scenes cleanup: leftover code from an older way of hosting the page is gone. Nothing changes for you']],
  ['2.0.0.0.7', ['When the sync script itself changes, the page asks you to update it before syncing. Page-only updates no longer ask you to update the script']],
  ['2.0.0.0.6', ['A changed icon now shows up straight away, instead of the browser holding on to the old one']],
  ['2.0.0.0.5', ['A bolder Halloween icon: a jack-o\'-lantern book with a glowing carved face']],
  ['2.0.0.0.4', ['A Shelf of Shame icon in your browser tab and on your home screen: a book with its price tag still on, or a cobwebbed book in the Halloween theme', 'Sending someone a link to the site shows a picture and a short description']],
  ['2.0.0.0.3', ['The calculator is now called Shelf of Shame everywhere, including the sync script and your Google Drive file']],
  ['2.0.0.0.2', ['Set up the bookmark: one tap copies the sync code and opens a page that walks you through saving it, already named Shelf sync', 'The sync script also works in Userscripts, the free script app for iPhone and iPad']],
  ['2.0.0.0.1', ['The bottom of Settings shows which version of the app and of the sync script you have', 'Tapping outside Settings closes it']],
  ['1.55', ['Faster on phones with big libraries: the library table loads 40 books at a time, scrolling no longer redraws the page, and search waits for a pause in typing']],
  ['1.54', ['On a phone, getting started offers three ways in: sync from Amazon with the bookmark, load from Google Drive, or import a file', 'Picking a file to import brings it in straight away', "Connecting a Google account whose Drive has no library yet says so"]],
  ['1.53', ['Books with no Amazon store page get a genre guessed from their title, marked "guessed"']],
  ['1.52', ['Keep your library in your own Google Drive and share it between your phone and computer (Settings › Google Drive)', 'A 10-book shelf on phones, with a globe (or cauldron) and a comic for the smallest genres']],
  ['1.51', ['Sync from your phone with a bookmark: nothing to install (Settings › Sync from your phone)']],
  ['1.50', ['"This year so far" above the summary: books added and money spent this year, with a monthly average', 'By status is a small table with Books and Pages columns', 'By status shows your shortest and longest unread books, the average length and how many are quick reads']],
  ['1.49', ['No more candles on the shelf, in any theme']],
  ['1.48', ['When Content & Devices wants your password again, the sync says so and links straight to it', 'The red dot on Settings goes away once you\'ve looked at what\'s new', 'A single flower in the vase on the shelf', 'Zon theme: sync problems are readable again']],
  ['1.47', ['Second genres and tags: a Fantasy book listed under Fantasy Romance also counts as Romance, shown as bands on its spine in By genre mode', 'Amazon\'s categories show as tags under each book in Your library, with a tag filter', 'A fresh look for the bookcase: outlined books, piles lying flat, and new knick-knacks', 'Every book\'s Amazon page gets one more look in the background to fill in the tags']],
  ['1.46', ['An out-of-date sync script now has to be updated before the page can be used']],
  ['1.45', ['Optional: shared and borrowed books on their own tab under Your library (turn it on in Settings)']],
  ['1.44', ['Fantasy and Science Fiction are separate genres now, each with its own spine color']],
  ['1.43', ['Setup ends with sign-in buttons for amazon.com, read.amazon.com and Goodreads', 'If the Kindle reader isn\'t signed in yet, your library comes from Content & Devices instead of failing', 'Goodreads not being linked is shown as a tip, not an error', 'The oldest-unread-book figure says plainly what it is']],
  ['1.42', ['Shelf decorations sit on the shelf: flat-bottomed pots and candle holders, potion stands, softer candle glow']],
  ['1.41', ['The empty end of the shelf gets a bookend and knick-knacks that fit the space and match your theme']],
  ['1.40', ['New Halloween theme: purple, slime green and pumpkin, with a moon and bats (no spiders)', 'Zon theme looks much more like an online bookstore']],
  ['1.39', ['Themes in Settings: Default, Cozy (candle-lit library), Zon (bright storefront) and Light']],
  ['1.38', ['"Time to read it all" leads with what\'s left, with a small table: whole library, still to read, and your pace']],
  ['1.37', ['Genres are Amazon\'s own now (Romance, Science Fiction & Fantasy…), with the sub-genre when you point at a spine', 'Fixed: paranormal romance was being counted as Horror', 'Your library gets one more look at each book page to pick these up']],
  ['1.36', ['The Sync box folds to a single line with an arrow; it folds itself when a sync finishes cleanly']],
  ['1.35', ['Prices paid fill in about 4 times faster: up to 150 orders per sync, paced so Amazon doesn\'t object', 'Library value shows where every dollar comes from (hover the line under it)']],
  ['1.34', ['Step-by-step setup the first time you visit', 'Sync progress shows each step with a progress bar, and problems in plain English', 'Updates and what\'s new live in Settings; the page updates itself']],
  ['1.33', ['Import a file and Back up moved into Settings', 'No more console script']],
  ['1.32', ['Just-bought books lead the shelf when it is colored by genre']],
  ['1.31', ['Reading status rings under "Books added per year" follow the year you point at']],
];

// ---------- the page keeps itself current: no Ctrl+F5 ----------
let pendingReload = false;
async function checkPageUpdate() {
  if (hasCore || location.protocol === 'file:') return;
  try {
    const t = await (await fetch(location.pathname + '?v=' + Date.now(), {cache: 'no-store'})).text();
    const m = t.match(/const LATEST_SCRIPT = '([\d.]+)'/);
    if (m && verLess(LATEST_SCRIPT, m[1])) { pendingReload = true; tryReload(); }
  } catch {}
}
// Reload only when nothing is in flight and no window is open, so nobody loses a sync or a half-typed edit
function tryReload() {
  if (!pendingReload || syncing || kpRunning || document.querySelector('dialog[open]')) return;
  ssSet('klc-updated-from', LATEST_SCRIPT);
  flushSave();
  location.reload();
}

// ---------- Settings: sync script status, update button, what's new ----------
// The dot on Settings means something new is waiting there. It goes once you've opened Settings and pointed at (or tapped) the new part.
const dotSeen = () => { try { return localStorage.getItem('klc-dot-seen') === LATEST_SCRIPT; } catch { return false; } };
function refreshDot() {
  const need = !dotSeen() && ((scriptVer && verLess(scriptVer, REQUIRED_SCRIPT)) || lsFlag('klc-unseen'));
  $('#btnSettings').classList.toggle('dot', !!need);
}
function renderScriptSect() {
  if (hasCore || location.protocol === 'file:') return;
  let sec = $('#scriptSect');
  if (!sec) {
    sec = document.createElement('div'); sec.className = 'files'; sec.id = 'scriptSect';
    const files = document.querySelector('#dlgSettings .files'); files.before(sec);
  }
  const out = scriptVer && verLess(scriptVer, REQUIRED_SCRIPT);
  const st = !syncOn ? `<p class="note">Not connected. The free sync script brings in your Kindle library, purchase dates and prices by itself.</p><div class="row"><button type="button" class="btn primary" id="sSetup">Set up sync</button></div>`
    : out ? `<p class="note"><b>Update ready.</b> You have version ${esc(verLabel(scriptVer))}; version ${verLabel(REQUIRED_SCRIPT)} is needed. Click Update, press <b>Update</b> in the Tampermonkey tab that opens, then come back. This page finishes by itself.</p><div class="row"><button type="button" class="btn primary" id="sUpdate">Update</button></div>`
    : `<p class="note" style="color:var(--ok)">✓ Sync script ${esc(verLabel(scriptVer || REQUIRED_SCRIPT))}, up to date.</p>`;
  const unseen = lsFlag('klc-unseen');
  sec.classList.toggle('fresh', !dotSeen() && (!!out || unseen));
  if (!sec.dataset.w) { sec.dataset.w = '1'; const seen = () => { if (!sec.classList.contains('fresh')) return; try { localStorage.setItem('klc-dot-seen', LATEST_SCRIPT); } catch {} lsSet1('klc-unseen', ''); sec.classList.remove('fresh'); refreshDot(); }; ['pointerenter', 'focusin', 'click'].forEach(ev => sec.addEventListener(ev, seen)); }
  sec.innerHTML = `<h4>Sync script and updates<span class="newtag">new</span></h4>${st}<details class="news"${unseen ? ' open' : ''}><summary>What's new${unseen ? ` in ${verLabel(LATEST_SCRIPT)}` : ''}</summary>${CHANGES.slice(0, 3).map(([v, n]) => `<p><b>${verLabel(v)}</b></p><ul>${n.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`).join('')}</details>`;
  const su = $('#sSetup'); if (su) su.onclick = () => { $('#dlgSettings').close(); openWizard('welcome'); };
  const up = $('#sUpdate'); if (up) up.onclick = () => { ssSet('klc-updating', '1'); window.open(SCRIPT_URL, '_blank', 'noopener'); up.textContent = 'Waiting for Tampermonkey…'; up.disabled = true; };
}
// Copy the bookmark code, then go to bookmark.html: a page titled "Shelf sync", so the bookmark saved there is already named
async function setupBookmark() {
  const code = bookmarkletCode();
  try { await navigator.clipboard.writeText(code); }
  catch { const t = document.createElement('textarea'); t.value = code; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch {} t.remove(); }
  location.href = 'bookmark.html#c';
}
// Settings: the phone sync bookmark (works in any browser, nothing to install)
function renderPhoneSect() {
  if (hasCore || $('#phoneSect')) return;
  const sec = document.createElement('div'); sec.className = 'files'; sec.id = 'phoneSect';
  const files = document.querySelector('#dlgSettings .files:not(#scriptSect):not(#phoneSect)') || document.querySelector('#dlgSettings .files'); files.before(sec);
  sec.innerHTML = `<h4>Sync from your phone (nothing to install)</h4>
    <p class="note">A bookmark does the syncing. Tap it while you're on amazon.com and it reads your books, purchase dates and prices right there in your browser, then sends them to this page. Nothing is installed and your data doesn't go anywhere else.</p>
    <div class="row"><button type="button" class="btn primary" id="bmSetup">Set up the bookmark</button><a class="btn" id="bmDrag" href="#">Shelf sync</a></div>
    <p class="note" style="margin-top:-4px">Copies the sync code and opens a short page that walks you through saving it. On a computer you can drag <b>Shelf sync</b> to your bookmarks bar instead.</p>
    <p class="note">The first time, it reads up to 80 books' genres and pages. Tap it again later to carry on with the rest.</p>`;
  $('#bmDrag').href = bookmarkletCode();
  $('#bmDrag').onclick = e => { e.preventDefault(); toast('Drag this to your bookmarks bar, or use Copy'); };
  $('#bmSetup').onclick = setupBookmark;
}
document.addEventListener('click', e => {
  if (!e.target.closest || !e.target.closest('#btnSettings')) return;
  renderVerLine();
  renderPhoneSect();
  renderScriptSect();
  renderDriveSect(); if (!hasCore && location.protocol !== 'file:') loadGis().catch(() => {});
});

// ---------- sync progress card ----------
const nb = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;
const STAGES = [['goodreads', 'Goodreads shelves'], ['kindle', 'Kindle library'], ['owned', 'Purchase dates'], ['prices', 'Prices paid'], ['details', 'Genres & pages']];
let cardErrs = [], cardTimer = 0;
function card() {
  let c = $('#syncCard');
  if (c) return c;
  c = document.createElement('section'); c.className = 'card synccard'; c.id = 'syncCard'; c.hidden = true;
  c.innerHTML = `<button type="button" class="schead" id="scHead" aria-expanded="true" aria-controls="scBody"><span class="chev" aria-hidden="true"></span><h3>Sync</h3><span class="scsum" id="scSum" aria-live="polite"></span></button>
    <div id="scBody"><p class="muted sc-note" id="scNote">You can keep using the page while this runs.</p>
    <div>${STAGES.map(([k, l]) => `<div class="stage" id="st-${k}" data-s="wait"><span class="ic"></span><span>${l}</span><div class="pbar"><i></i></div><span class="r"></span></div>`).join('')}</div>
    <div id="scErrs"></div></div>`;
  document.querySelector('header.top').after(c);
  $('#scHead').onclick = () => { const col = !c.classList.contains('collapsed'); setCollapsed(col); lsSet1('klc-sync-collapsed', col ? '1' : ''); };
  setCollapsed(lsFlag('klc-sync-collapsed'));
  return c;
}
// Folded, the box is one line: "Sync" plus where it is (running step, last sync time, or a problem)
function setCollapsed(col) { const c = $('#syncCard'); c.classList.toggle('collapsed', col); $('#scHead').setAttribute('aria-expanded', !col); $('#scBody').hidden = col; }
const sum = (txt, kind) => { const e = $('#scSum'); e.textContent = txt; e.dataset.k = kind || ''; };
function stage(k, st, txt, frac) {
  const r = card().querySelector('#st-' + k); if (!r) return;
  r.dataset.s = st;
  r.querySelector('.ic').textContent = {ok: '✓', run: '●', err: '!', skip: '–', wait: ''}[st] || '';
  r.querySelector('.r').textContent = txt || '';
  r.querySelector('.pbar i').style.width = (st === 'ok' || st === 'skip' ? 100 : Math.round(Math.max(0, Math.min(1, frac || 0)) * 100)) + '%';
  if (st === 'run') sum(`${STAGES.find(x => x[0] === k)[1]}${txt ? ' · ' + txt : ''}`, 'run');
}
function cardStart() {
  clearTimeout(cardTimer); cardErrs = []; cardNotes = [];
  const c = card(); c.hidden = false; $('#sync').hidden = true; $('#scErrs').innerHTML = ''; $('#scNote').hidden = false;
  STAGES.forEach(([k]) => stage(k, 'wait')); sum('Starting…', 'run');
}
const before = k => { const i = STAGES.findIndex(x => x[0] === k); STAGES.slice(0, i).forEach(([p]) => { const r = $('#st-' + p); if (r && r.dataset.s === 'run') stage(p, 'ok', r.querySelector('.r').textContent); }); };
function syncProgress(msg) {
  setSync(msg);
  let m;
  if (/goodreads/i.test(msg)) stage('goodreads', 'run', 'reading…', 0.3);
  else if ((m = msg.match(/Kindle library…\s*(\d+)?/))) { before('kindle'); stage('kindle', 'run', m[1] ? nb(+m[1], 'book') : 'reading…', 0.5); }
  else if ((m = msg.match(/purchase dates…\s*(\d+)?(?: of (\d+))?/i))) { before('owned'); stage('owned', 'run', m[1] ? `${fmtInt(+m[1])}${m[2] ? ' of ' + fmtInt(+m[2]) : ''}` : 'reading…', m[2] ? m[1] / m[2] : 0.3); }
  else if ((m = msg.match(/prices paid…\s*(\d+) of (\d+)/i))) { before('prices'); stage('prices', 'run', `${m[1]} of ${m[2]}`, m[1] / m[2]); }
}
function friendly(src, err, key) {
  const host = (err.match(/sign in at (\S+?) first/) || [])[1];
  // Content & Devices asks for your password again every so often, even while amazon.com shows you signed in
  if (host && key === 'owned') return {html: `<b>Amazon wants your password again for Content &amp; Devices.</b> Open <a href="https://${esc(host)}/hz/mycd/digital-console/contentlist/booksAll/dateDsc/" target="_blank" rel="noopener">Content &amp; Devices</a> in this browser, sign in if it asks, then press Retry. Amazon does this now and then for that page, even when the rest of amazon.com shows you signed in.`};
  if (host && /^read\./.test(host)) return {html: `<b>Open <a href="https://${esc(host)}" target="_blank" rel="noopener">${esc(host)}</a> once in this browser and sign in.</b> The Kindle reader has its own sign-in, separate from amazon.com. Then press Retry.`};
  if (host) return {html: `<b>Sign in to <a href="https://${esc(host)}" target="_blank" rel="noopener">${esc(host)}</a></b> in this browser, then press Retry.`};
  const code = (err.match(/\b(5\d\d|429)\b/) || [])[1];
  if (code || /unavailable|timed? ?out|network/i.test(err)) return {html: `<b>${src} is having trouble right now</b>${code ? ` (it answered "${code}")` : ''}. Nothing to fix on your side; it is picked up on the next sync.`};
  return {html: `<b>${src}:</b> ${esc(err)}`};
}
let cardNotes = [];
function cardNote(html) { cardNotes.push(html); drawCardMsgs(); }
function drawCardMsgs() {
  $('#scErrs').innerHTML = cardNotes.map(h => `<div class="warnline info"><span>${h}</span></div>`).join('') + cardErrs.map(e => `<div class="warnline"><span>${e.html}</span></div>`).join('') +
    (cardErrs.length ? `<div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="scRetry">Retry</button></div>` : '');
  const r = $('#scRetry'); if (r) r.onclick = () => runSync(true);
}
function cardError(key, err, plain) {
  const src = {goodreads: 'Goodreads', kindle: 'Amazon', owned: 'Amazon', prices: 'Amazon', details: 'Amazon', sync: 'The sync'}[key] || 'Sync';
  cardErrs.push(plain ? {html: esc(err)} : friendly(src, err, key));
  drawCardMsgs();
  if (!syncing && !kpRunning) sum(`Finished with ${cardErrs.length === 1 ? 'a problem' : cardErrs.length + ' problems'} · click to see`, 'err');
}
function cardResult(d, nGr, nK, dated, priced, fromOwned) {
  // Goodreads is optional: not being signed in there is a tip, not a problem
  if (d.grErr && /sign in/i.test(d.grErr)) { stage('goodreads', 'skip', 'not linked'); cardNote('<b>Optional:</b> sign in to <a href="https://www.goodreads.com" target="_blank" rel="noopener">goodreads.com</a> in this browser and books you\'ve marked read there count as read here.'); }
  else if (d.grErr) { stage('goodreads', 'err', 'not this time'); cardError('goodreads', d.grErr); } else stage('goodreads', nGr ? 'ok' : 'skip', nGr ? nb(nGr, 'book') : 'not linked');
  if (fromOwned) { stage('kindle', 'ok', nb(nK, 'book')); cardNote('Your books came from Amazon\'s Content & Devices list. For <b>reading progress</b>, open <a href="https://read.amazon.com" target="_blank" rel="noopener">read.amazon.com</a> once in this browser and sign in (the Kindle reader has its own sign-in), then sync again.'); }
  else if (d.kErr && !nK) { stage('kindle', 'err', 'failed'); cardError('kindle', d.kErr); } else stage('kindle', 'ok', nb(nK, 'book'));
  if (d.oErr) { stage('owned', 'err', 'failed'); cardError('owned', d.oErr); } else stage('owned', dated ? 'ok' : 'skip', dated ? nb(dated, 'date') : 'none');
  if (d.pErr) { stage('prices', 'err', 'failed'); cardError('prices', d.pErr); } else if (d.oErr) stage('prices', 'skip', 'needs purchase dates'); else stage('prices', 'ok', priced ? `${fmtInt(priced)} new` : 'up to date');
  if (d.pPaused) cardError('prices', `Amazon asked us to slow down while reading your orders${priced ? `, after ${priced} prices` : ''}. The rest are read on your next sync.`, true);
  if (!nGr && !nK) { stage('details', 'skip', ''); cardMaybeDone(); return; }
  stage('details', 'run', 'starting…', 0);
}
function cardMaybeDone() {
  const c = $('#syncCard'); if (!c || c.hidden) return;
  $('#scNote').hidden = true;
  const when = new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  if (cardErrs.length) { sum(`Finished ${when} with ${cardErrs.length === 1 ? 'a problem' : cardErrs.length + ' problems'} · click to see`, 'err'); return; }
  if (cardNotes.length) { sum(`✓ Synced ${when} · ${cardNotes.length === 1 ? 'a tip' : cardNotes.length + ' tips'} below`, 'ok'); return; } // stay open so the tips get seen
  sum(`✓ Synced ${when}`, 'ok');
  cardTimer = setTimeout(() => setCollapsed(true), 1500); // all good: fold to one line by itself
}

// ---------- first-visit setup walkthrough ----------
const UA = navigator.userAgent;
const BR = /OPR\//.test(UA) ? 'opera' : /Edg\//.test(UA) ? 'edge' : /Firefox\//.test(UA) ? 'firefox' : /Chrome\//.test(UA) ? 'chrome' : 'other';
const BRNAME = {opera: 'Opera', edge: 'Edge', firefox: 'Firefox', chrome: 'Chrome', other: 'your browser'}[BR];
// iPads ask for the desktop version of sites and call themselves a Mac, so a touch screen on a "Mac" means an iPad
const MOBILE = /Mobi|Android|iPhone|iPad/i.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 0); // Macs have no touch screen
const EXT_PAGE = {opera: 'opera://extensions', edge: 'edge://extensions', chrome: 'chrome://extensions'}[BR];
const WSTEPS = ['welcome', 'tm', ...(EXT_PAGE ? ['allow'] : []), 'script', 'done'];
let wizAt = 'welcome';
function wizEl() {
  let d = $('#dlgWiz'); if (d) return d;
  d = document.createElement('dialog'); d.id = 'dlgWiz'; d.className = 'wizdlg';
  d.innerHTML = '<div class="dlg wiz" id="wizBody"></div>';
  d.addEventListener('cancel', e => { e.preventDefault(); wizSkip(); });
  document.body.append(d); return d;
}
function openWizard(step) { const d = wizEl(); if (!d.open) d.showModal(); wizGo(step); }
function wizSkip() { lsSet1('klc-wiz-skip', '1'); ssSet('klc-wiz', ''); const d = $('#dlgWiz'); if (d && d.open) d.close(); tryReload(); }
function wizConnected() { if ($('#dlgWiz')?.open) wizGo('done'); ssSet('klc-wiz', ''); }
const copyBtn = txt => `<button type="button" class="btn" data-copy="${txt}">Copy address</button>`;
function wizGo(step) {
  wizAt = step;
  const idx = Math.max(0, WSTEPS.indexOf(step === 'check' ? 'script' : step)), n = WSTEPS.length;
  const dots = `<div class="pp">${WSTEPS.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div><div class="count">STEP ${idx + 1} OF ${n}</div>`;
  const nav = (back, next, nextLabel = 'Next') => `<div class="row wnav">${back ? `<button type="button" class="btn" data-go="${back}">Back</button>` : '<span></span>'}${next ? `<button type="button" class="btn primary" data-go="${next}">${nextLabel}</button>` : ''}</div>`;
  const prev = s => WSTEPS[WSTEPS.indexOf(s) - 1], next = s => WSTEPS[WSTEPS.indexOf(s) + 1];
  const skip = '<button type="button" class="linkbtn" id="wizSkip">Skip setup and look at the example</button>';
  const v = {
    welcome: MOBILE ? `<h2>Get your own Shelf of Shame</h2>
      <p>Pick how to bring in your books. Nothing to install.</p>
      <div class="wpick">
        <button type="button" class="btn primary" id="wzBm"><b>Sync from Amazon</b><span>A bookmark reads your Kindle books on amazon.com, right on this phone</span></button>
        <button type="button" class="btn" id="wzGd"><b>Load from Google Drive</b><span>Already use the calculator on another device with Google Drive? Bring that library here</span></button>
        <button type="button" class="btn" id="wzFile"><b>Import a file</b><span>A backup from another device, or a Goodreads export</span></button>
      </div>` : `<h2>Get your own Shelf of Shame</h2>
      <p>About five minutes, one time. A free browser add-on (Tampermonkey) runs a small script that reads your Kindle library while you're signed in to Amazon. Nothing to download or paste, and your books stay in this browser.</p>
      ${MOBILE ? '' : BR === 'other' ? `<p class="wwarn">This works in Chrome, Edge, Opera or Firefox on a computer. Open this page in one of those to continue.</p>` : `<p class="muted">Looks like you're using <b>${BRNAME}</b>. The steps below are written for it.</p>`}
      ${nav(null, MOBILE || BR === 'other' ? null : 'tm', "Let's go")}`,
    tm: `<h2>Add Tampermonkey to ${BRNAME}</h2>
      <p>It's a free, widely used add-on that runs small scripts on websites you choose.</p>
      <div class="row" style="justify-content:center"><a class="btn primary" href="https://www.tampermonkey.net/?browser=${BR}" target="_blank" rel="noopener">Get Tampermonkey for ${BRNAME}</a></div>
      <p class="muted">Click <b>Add to ${BRNAME}</b> on the page that opens, then come back to this tab. Already have it? Just press Next.</p>
      ${nav('welcome', next('tm'))}`,
    allow: `<h2>Let Tampermonkey run scripts</h2>
      <p>${BRNAME} needs one switch turned on. Paste <span class="kbd">${EXT_PAGE}</span> into the address bar, click <b>Details</b> under Tampermonkey, and turn this on:</p>
      <div class="fake"><span><b>Allow User Scripts</b><br><span class="muted">Allow this extension to run user scripts</span></span><span class="tog"></span></div>
      <p class="muted">Don't see it? Turn on <b>Developer mode</b> at the top right of that page instead.</p>
      <div class="row" style="justify-content:center">${copyBtn(EXT_PAGE)}</div>
      ${nav('tm', 'script', 'Done')}`,
    script: `<h2>Install the sync script</h2>
      <p>Tampermonkey opens a page with an <b>Install</b> button. Click it, then come back to this tab and press <b>I installed it</b>.</p>
      <div class="row" style="justify-content:center"><a class="btn primary" href="${SCRIPT_URL}" target="_blank" rel="noopener" id="wizInstall">Install the sync script</a></div>
      <p class="muted">The page reloads once to pick up the script.</p>
      <div class="row wnav"><button type="button" class="btn" data-go="${prev('script')}">Back</button><button type="button" class="btn primary" id="wizCheck">I installed it</button></div>`,
    check: `<h2>Looking for the script…</h2><p class="muted">This only takes a few seconds.</p><div class="spin" aria-hidden="true"></div>`,
    trouble: `<h2>The script isn't answering yet</h2>
      <p>Almost always one of these:</p>
      <ul class="wlist">${EXT_PAGE ? `<li><b>Allow User Scripts is off.</b> <span class="kbd">${EXT_PAGE}</span> → Tampermonkey → Details → turn it on.</li>` : ''}
      <li><b>The script is switched off.</b> Click the Tampermonkey icon in the toolbar and make sure <b>Shelf of Shame</b> is on.</li>
      <li><b>The install didn't finish.</b> Go back a step and press Install again.</li></ul>
      <div class="row wnav"><button type="button" class="btn" data-go="script">Back</button><button type="button" class="btn primary" id="wizCheck">Try again</button></div>`,
    done: `<h2>You're connected ✓</h2>
      <p>Last step: make sure this browser is signed in where your books live. Open each one, sign in if it asks, then come back here.</p>
      <ul class="wlist signin"><li><a class="btn" href="https://www.amazon.com" target="_blank" rel="noopener">amazon.com</a> your library, purchase dates and prices</li>
      <li><a class="btn" href="https://read.amazon.com" target="_blank" rel="noopener">read.amazon.com</a> the Kindle reader has its own sign-in; it gives reading progress</li>
      <li><a class="btn" href="https://www.goodreads.com" target="_blank" rel="noopener">goodreads.com</a> optional: books you marked read there count as read here</li></ul>
      <p class="muted">Book details (genres, pages, prices) then fill in over a few minutes, about a second per book.</p>
      <div class="row wnav" style="justify-content:center"><button type="button" class="btn primary" id="wizClose">I'm signed in, sync now</button></div>`,
  }[step];
  $('#wizBody').innerHTML = (step === 'check' || step === 'trouble' || MOBILE ? '' : dots) + v + (step === 'done' ? '' : skip);
  const b = $('#wizBody');
  b.querySelectorAll('[data-go]').forEach(x => x.onclick = () => wizGo(x.dataset.go));
  b.querySelectorAll('[data-copy]').forEach(x => x.onclick = async () => { try { await navigator.clipboard.writeText(x.dataset.copy); x.textContent = 'Copied ✓'; } catch { x.textContent = x.dataset.copy; } });
  const sk = $('#wizSkip'); if (sk) sk.onclick = wizSkip;
  const wb = $('#wzBm'); if (wb) wb.onclick = () => { wizSkip(); setupBookmark(); };
  const wg = $('#wzGd'); if (wg) wg.onclick = () => { wizSkip(); syncDrive(true); };
  const wf = $('#wzFile'); if (wf) wf.onclick = () => { wizSkip(); openImport(); };
  const cl = $('#wizClose'); if (cl) cl.onclick = () => { $('#dlgWiz').close(); ssSet('klc-wiz', ''); runSync(true); };
  const ck = $('#wizCheck'); if (ck) ck.onclick = () => { ssSet('klc-wiz', 'check'); location.reload(); };
  if (step === 'check') setTimeout(() => { if (!syncOn && wizAt === 'check') { ssSet('klc-wiz', ''); wizGo('trouble'); } }, 2500);
  if (step !== 'check' && step !== 'done' && step !== 'trouble') ssSet('klc-wiz', step === 'welcome' ? '' : step);
}

// ---------- styles for the pieces above ----------
(() => {
  const st = document.createElement('style');
  st.textContent = `
#btnSettings.dot{position:relative}#btnSettings.dot::after{content:"";position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:50%;background:var(--shame);border:2px solid var(--bg)}
.gdstore{background:none;border:0;padding:0;cursor:pointer;font:inherit;font-family:var(--mono);font-size:.74rem;color:var(--muted)}
.gdstore[data-k=tap]{text-decoration:underline dotted}
.bmsteps{margin:6px 0 0;padding-left:20px;font-size:.84rem;display:flex;flex-direction:column;gap:4px}
.newtag{display:none;margin-left:8px;vertical-align:2px;font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#fff;background:var(--shame);border-radius:999px;padding:1px 7px}
#scriptSect.fresh{outline:2px solid var(--shame);outline-offset:6px;border-radius:4px;transition:outline-color .3s}#scriptSect.fresh .newtag{display:inline-block}
.news summary{cursor:pointer;font-size:.85rem;font-weight:600}.news p{margin:8px 0 2px;font-size:.82rem}.news ul{margin:0;padding-left:18px;font-size:.82rem}
.synccard{margin-top:14px;gap:8px;padding:12px 18px}.synccard .sc-note{font-size:.8rem;margin:0 0 4px}
.schead{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;cursor:pointer;min-height:28px;border-radius:6px}.schead:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.schead h3{margin:0}.chev{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid var(--muted);transition:transform .15s}.collapsed .chev{transform:rotate(-90deg)}
.scsum{margin-left:auto;font-family:var(--mono);font-size:.76rem;color:var(--muted);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.scsum[data-k=ok]{color:var(--ok)}.scsum[data-k=err]{color:var(--shame)}.scsum[data-k=run]{color:var(--accent)}
.synccard.collapsed{padding-block:8px}
.stage{display:grid;grid-template-columns:18px minmax(110px,150px) 1fr minmax(90px,auto);gap:10px;align-items:center;font-size:.86rem;padding:4px 0}
.stage .ic{font-family:var(--mono);text-align:center;color:var(--accent)}.stage[data-s=ok] .ic{color:var(--ok)}.stage[data-s=err] .ic{color:var(--shame)}
.stage[data-s=wait],.stage[data-s=skip]{color:var(--muted)}
.stage .pbar{height:8px;background:var(--rule);border-radius:4px;overflow:hidden}.stage .pbar i{display:block;height:100%;width:0;background:var(--accent);border-radius:4px;transition:width .3s}
.stage[data-s=ok] .pbar i{background:var(--ok)}.stage[data-s=skip] .pbar i{background:transparent}.stage[data-s=err] .pbar i{background:var(--shame)}
.stage .r{font-family:var(--mono);font-size:.74rem;color:var(--muted);text-align:right;white-space:nowrap}
@media (max-width:560px){.stage{grid-template-columns:18px 1fr auto}.stage .pbar{grid-column:2/4;grid-row:2}}
.warnline.info{border-left-color:var(--accent)}
.wiz .wlist.signin{list-style:none;padding:0;gap:8px}.wiz .wlist.signin li{display:grid;grid-template-columns:160px 1fr;gap:12px;align-items:center;font-size:.86rem;color:var(--muted)}.wiz .wlist.signin .btn{text-align:center}
.warnline{font-size:.84rem;border-left:3px solid var(--warn);padding:6px 10px;background:var(--bg);border-radius:0 6px 6px 0;margin-top:6px}.warnline a{color:inherit}
.wizdlg:focus,.wiz :focus:not(:focus-visible){outline:none}.wiz a.btn{text-decoration:none}
.forcedlg::backdrop{background:rgba(0,0,0,.28)}.forcedlg{border:1px solid var(--rule);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.45);background:var(--paper);color:var(--ink)}.forceicon{font-size:2rem;line-height:1;color:var(--accent)}
.wpick{display:flex;flex-direction:column;gap:10px;text-align:left}.wpick .btn{display:flex;flex-direction:column;gap:2px;padding:12px 14px;white-space:normal}.wpick .btn span{font-weight:400;font-size:.82rem;opacity:.8}
.wizdlg{max-width:min(560px,calc(100vw - 32px));width:100%}
.wiz{text-align:center;display:flex;flex-direction:column;gap:14px}.wiz h2{font-size:1.4rem}.wiz p{margin:0}
.wiz .count{font-family:var(--mono);font-size:.72rem;color:var(--muted);letter-spacing:.08em;margin-top:-6px}
.wiz .pp{display:flex;gap:6px;justify-content:center}.wiz .pp i{width:28px;height:4px;border-radius:2px;background:var(--rule)}.wiz .pp i.on{background:var(--accent)}
.wiz .wnav{justify-content:space-between}.wiz .wlist{text-align:left;margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:.9rem}
.wiz .wwarn{border-left:3px solid var(--warn);background:var(--bg);padding:8px 10px;text-align:left;font-size:.88rem;border-radius:0 6px 6px 0}
.kbd{font-family:var(--mono);font-size:.8rem;background:var(--bg);border:1px solid var(--rule);border-radius:4px;padding:1px 6px;white-space:nowrap}
.fake{border:1px solid var(--rule);border-radius:8px;padding:10px 14px;text-align:left;font-size:.84rem;background:var(--bg);display:flex;justify-content:space-between;align-items:center;gap:12px}
.tog{flex:none;width:34px;height:18px;border-radius:9px;background:var(--accent);position:relative;outline:3px solid #e0a800;outline-offset:3px}.tog::after{content:"";position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff}
.linkbtn{background:none;border:0;color:var(--accent);text-decoration:underline;font:inherit;font-size:.82rem;cursor:pointer;align-self:center}
.spin{width:28px;height:28px;border:3px solid var(--rule);border-top-color:var(--accent);border-radius:50%;margin:4px auto;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}.stage .pbar i{transition:none}}`;
  document.head.append(st);
})();

// ---------- Google Drive (optional): the library kept in one file in the user's own Drive ----------
// The page talks to Google straight from the browser. The permission ("drive.file") only reaches files this site created,
// and the sign-in token lives in this tab's memory. Nothing goes through any server of ours.
const GD_CLIENT = '415875336210-7sqa3p2evj9on6be8vu7pal417g39hme.apps.googleusercontent.com';
const GD_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GD_NAME = 'Shelf of Shame.json';
const GD_OLD = 'Kindle Library Calculator.json'; // the file's name before the rename; found and renamed on the next sync
const GD_DESC = 'Your Shelf of Shame library (bookshelf.kirbee213.tv). Delete it any time.';
const gdGet = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const gdSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };
const gd = {token: '', exp: 0, client: null, busy: false, timer: 0, lastHash: '', state: '', when: 0, err: ''};
const gdOn = () => !!gdGet('klc-gd-on');

// Same JSON for the same data whatever order the fields were added in, so "changed since last sync" is reliable
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
const bookKey = b => b.asin ? 'a:' + String(b.asin).toUpperCase() : 'i:' + b.id;
const libHash = books => { let h = 0; const s = stable(books); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + ':' + h; };

// Three-way merge per book against what both sides last agreed on, so changes made on either device survive
function mergeLibraries(local, remote, base) {
  const L = new Map(local.map(b => [bookKey(b), b])), R = new Map(remote.map(b => [bookKey(b), b]));
  const out = [];
  for (const k of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(k), r = R.get(k), b = base[k]; // b is the agreed version as stable JSON, or undefined
    if (l && r) {
      const ls = stable(l), rs = stable(r);
      if (ls === rs || ls === b) { out.push(r); continue; }   // unchanged here: take theirs
      if (rs === b) { out.push(l); continue; }                // unchanged there: keep ours
      const bo = b ? JSON.parse(b) : {}, m = {...r};
      for (const f of new Set([...Object.keys(l), ...Object.keys(r)])) {
        const lv = stable(l[f]), rv = stable(r[f]), bv = stable(bo[f]);
        if (lv === bv) m[f] = r[f];
        else if (rv === bv) m[f] = l[f];
        else m[f] = l[f] != null && l[f] !== '' ? l[f] : r[f];   // both changed it: this device wins, unless it has nothing
      }
      m.id = l.id; out.push(m);
    } else if (l) { if (!(b && stable(l) === b)) out.push(l); }  // gone there and untouched here: it was deleted
    else if (r) { if (!(b && stable(r) === b)) out.push(r); }
  }
  return out;
}
const snapshot = books => { const m = {}; books.forEach(b => { m[bookKey(b)] = stable(b); }); return m; };
function gdBase() { try { return JSON.parse(localStorage.getItem('klc-gd-base') || '{}'); } catch { return {}; } }
function gdSaveBase(books) { try { localStorage.setItem('klc-gd-base', JSON.stringify(snapshot(books))); } catch {} }

let gisLoading = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return gisLoading ||= new Promise((ok, bad) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = ok; s.onerror = () => { gisLoading = null; bad(new Error("Couldn't reach Google")); }; document.head.appendChild(s); });
}
// A token lasts about an hour. Getting one shows Google's window, which browsers only allow right after a tap.
function gdToken(interactive) {
  if (gd.token && Date.now() < gd.exp - 60000) return Promise.resolve(gd.token);
  if (!interactive || !window.google?.accounts?.oauth2) return Promise.reject(Object.assign(new Error('tap'), {tap: true}));
  return new Promise((ok, bad) => {
    gd.client = google.accounts.oauth2.initTokenClient({client_id: GD_CLIENT, scope: GD_SCOPE,
      callback: r => { if (r.error || !r.access_token) { bad(new Error(r.error_description || r.error || 'Google said no')); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, GD_SCOPE)) { bad(new Error('Tick the box that lets the calculator use its file in your Drive, then try again.')); return; }
        gd.token = r.access_token; gd.exp = Date.now() + (+r.expires_in || 3600) * 1000; ok(gd.token); },
      error_callback: e => bad(new Error(e && e.type === 'popup_closed' ? 'The Google window was closed' : e && e.type === 'popup_failed_to_open' ? 'Your browser blocked the Google window. Allow pop-ups for this site and tap again.' : "Couldn't connect to Google"))});
    gd.client.requestAccessToken({prompt: gdOn() ? '' : 'consent'});
  });
}
async function gapi(method, url, body, type) {
  const r = await fetch(url, {method, headers: {Authorization: 'Bearer ' + gd.token, ...(type ? {'Content-Type': type} : {})}, body});
  if (r.status === 401) { gd.token = ''; throw Object.assign(new Error('tap'), {tap: true}); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Google Drive answered ${r.status}`);
  return r;
}
// A library file saved before the rename keeps its contents and just gets the new name. If renaming fails, the old name still works.
// The modified time read before the rename is kept, so a change saved from another device still counts as new.
async function gdRename(f) {
  if (f.name !== GD_OLD) return f;
  try { const r = await gapi('PATCH', `https://www.googleapis.com/drive/v3/files/${f.id}?fields=id`, JSON.stringify({name: GD_NAME, description: GD_DESC}), 'application/json'); if (r) return {...f, name: GD_NAME}; } catch {}
  return f;
}
async function gdFind() {
  const id = gdGet('klc-gd-file'), F = 'id,name,modifiedTime,trashed';
  if (id) { const r = await gapi('GET', `https://www.googleapis.com/drive/v3/files/${id}?fields=${F}`); if (r) { const f = await r.json(); if (!f.trashed) return gdRename(f); } }
  const q = encodeURIComponent(`(name = '${GD_NAME}' or name = '${GD_OLD}') and trashed = false`);
  const r = await gapi('GET', `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(${F})`);
  const f = r && (await r.json()).files?.[0];
  if (f) gdSet('klc-gd-file', f.id);
  return f ? gdRename(f) : null;
}
async function gdWrite(id, obj) {
  const data = JSON.stringify(obj);
  let r;
  if (id) r = await gapi('PATCH', `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&fields=id,modifiedTime`, data, 'application/json');
  if (!r) {
    const b = 'klc' + Date.now();
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name: GD_NAME, mimeType: 'application/json', description: GD_DESC})}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${data}\r\n--${b}--`;
    r = await gapi('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', body, 'multipart/related; boundary=' + b);
  }
  const f = await r.json(); gdSet('klc-gd-file', f.id); gdSet('klc-gd-mtime', f.modifiedTime); return f;
}

let gdApplying = false;
async function syncDrive(interactive) {
  if (gd.busy) return;
  gd.busy = true; gdStatus('run');
  try {
    if (interactive) await loadGis();
    await gdToken(interactive);
    await storeReady;
    const f = await gdFind();
    let changed = false;
    if (f && f.modifiedTime !== gdGet('klc-gd-mtime')) { // someone saved from another device since we last looked
      const remote = await (await gapi('GET', `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`)).json();
      const rb = Array.isArray(remote?.books) ? remote.books : [];
      if (S.demo) { S.books = rb; S.demo = false; if (remote.settings) S.settings = migrateSettings({...DEFAULTS, ...remote.settings}); }
      else S.books = mergeLibraries(S.books, rb, gdBase());
      changed = true;
    }
    if (!f && S.demo) { // nothing in this Google account's Drive yet, and nothing here to put there
      gdSet('klc-gd-on', '1'); gd.when = 0; gd.err = '';
      gdStatus('tap'); renderDriveSect();
      if (interactive) toast("Connected, but this Google account's Drive has no library yet. Sync from Amazon first, and it's saved there.");
      return;
    }
    if (!S.demo) await gdWrite(f && f.id, {app: 'kindle-library-calculator', saved: new Date().toISOString(), settings: S.settings, books: S.books});
    gdSaveBase(S.books); gd.lastHash = libHash(S.books);
    gdSet('klc-gd-on', '1'); gd.when = Date.now(); gdSet('klc-gd-when', String(gd.when)); gd.err = '';
    if (changed) { gdApplying = true; renderAll(); scheduleSave(); gdApplying = false; if (interactive) toast('Library synced with Google Drive'); }
    gdStatus('ok');
  } catch (e) {
    if (e.tap) gdStatus('tap'); else { gd.err = e.message || String(e); gdStatus('err'); if (interactive) toast(gd.err); }
  } finally { gd.busy = false; renderDriveSect(); }
}
// After any change saved in this browser, send it to Drive a few seconds later (if the hour-long sign-in is still good)
function driveQueue() {
  if (!gdOn() || gdApplying || S.demo) return;
  // Comparing the whole library is slow on a phone, so it's done once, when the few seconds' wait is over
  clearTimeout(gd.timer); gd.timer = setTimeout(() => { if (libHash(S.books) !== gd.lastHash) syncDrive(false); }, 4000);
}
function gdStatus(state) {
  gd.state = state;
  let el = document.getElementById('gdStore');
  if (!el) { el = document.createElement('button'); el.type = 'button'; el.id = 'gdStore'; el.className = 'store gdstore'; el.onclick = () => syncDrive(true); $('#store').after(el); }
  el.hidden = !gdOn() && state !== 'run';
  const t = gd.when ? new Date(gd.when).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : '';
  el.dataset.k = state;
  el.innerHTML = '<i></i>' + (state === 'run' ? 'Google Drive: syncing…' : state === 'ok' ? `Google Drive: synced ${t}` : state === 'err' ? 'Google Drive: There is a problem with the sync. Tap to retry.' : 'Google Drive: tap to sync');
  el.title = state === 'err' ? gd.err : state === 'tap' ? 'Google sign-ins last about an hour. Tap to sync your library with your Drive.' : 'Your library is saved in your own Google Drive';
}
function renderDriveSect() {
  if (hasCore) return;
  let sec = document.getElementById('driveSect');
  if (!sec) {
    const after = document.getElementById('scriptSect') || document.querySelector('#dlgSettings .files');
    if (!after) return;
    sec = document.createElement('div'); sec.className = 'files'; sec.id = 'driveSect'; after.before(sec);
  }
  const on = gdOn(), t = gd.when ? new Date(gd.when).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '';
  sec.innerHTML = `<h4>Google Drive</h4>` + (on
    ? `<p class="note">Your library is kept in <b>${GD_NAME}</b> in your own Google Drive${t ? `, last synced ${esc(t)}` : ''}. Connect the same Google account on your phone or another computer and they share it. Changes made on each are merged book by book.</p>
       <div class="row"><button type="button" class="btn primary" id="gdSync">Sync now</button><button type="button" class="btn" id="gdOff">Disconnect</button></div>${gd.err ? `<p class="note" style="color:var(--shame)">${esc(gd.err)}</p>` : ''}`
    : `<p class="note">Keep your library in your own Google Drive, so your phone and computer show the same books. The calculator can only see the one file it makes there, nothing else in your Drive, and nothing passes through anyone else's server. <a href="privacy.html" target="_blank" rel="noopener">Privacy</a></p>
       <div class="row"><button type="button" class="btn primary" id="gdOn">Connect Google Drive</button></div>`);
  const c = document.getElementById('gdOn'); if (c) c.onclick = () => syncDrive(true);
  const s = document.getElementById('gdSync'); if (s) s.onclick = () => syncDrive(true);
  const o = document.getElementById('gdOff'); if (o) o.onclick = () => {
    if (gd.token && window.google?.accounts?.oauth2) try { google.accounts.oauth2.revoke(gd.token, () => {}); } catch {}
    gd.token = ''; ['klc-gd-on', 'klc-gd-file', 'klc-gd-mtime', 'klc-gd-base', 'klc-gd-when'].forEach(k => gdSet(k, ''));
    gdStatus('off'); renderDriveSect(); toast('Disconnected. Your library stays here, and the file stays in your Drive until you delete it.');
  };
}
function initDrive() {
  if (hasCore || location.protocol === 'file:') return;
  if (!gdOn()) return;
  gd.when = +gdGet('klc-gd-when') || 0;
  loadGis().catch(() => {}); // ready for the first tap, so Google's window isn't blocked
  storeReady.then(() => { gd.lastHash = libHash(S.books); gdStatus('tap'); });
}

// ---------- export ----------
$('#btnExport').onclick = async () => {
  const data = JSON.stringify({app:'kindle-library-calculator', exported:new Date().toISOString(), settings:S.settings, books:S.books}, null, 1);
  const name = `kindle-library-${new Date().toISOString().slice(0,10)}.json`;
  try { const u = URL.createObjectURL(new Blob([data], {type:'application/json'})); const l = document.createElement('a'); l.href = u; l.download = name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); toast('Backup downloaded'); return; } catch {}
  try { await navigator.clipboard.writeText(data); toast('Backup copied to clipboard'); } catch { toast('Downloads are not available here'); }
};

let tt;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2600); }

renderAll();
storeReady = initStore();
startSync();

})
