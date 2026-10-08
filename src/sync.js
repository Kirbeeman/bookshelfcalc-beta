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
const SIGN_KEY = '__SIGN_KEY__';
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
  storeReady.then(() => setTimeout(showNotice, 1800));
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

const ORIGIN = {purchase:'purchase', sharing:'shared', kindleunlimited:'ku', prime:'prime', primereading:'prime', sample:'sample', publiclibrarylending:'other', personallending:'other', rental:'other', koll:'other', freetrial:'free', comicsunlimited:'ku'};
// Real purchase dates from Amazon replace missing or estimated ones; Kindle's "Mark as read" marks a book finished
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
  if (b.genreSrc !== 'manual') { const g = amazonGenre(inf); if (g) { b.genre = g.key; b.genreName = g.name; b.genreSub = g.sub; b.genreSrc = 'amazon'; } else if (b.genreSrc === 'amazon') { b.genre = ''; b.genreName = ''; b.genreSub = ''; b.genreSrc = ''; } } // no trail: drop a genre that came from the old best-seller lists
  b.tagsAmz = amazonTags(inf); b.tags = b.tagsAmz.slice(); // grouped into Parent › Sub-genre on the next redraw
  if (b.genre2Src !== 'manual') b.genre2 = secondGenre(b.tagsAmz, b.genre);
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
const LATEST_SCRIPT = '__SCRIPT_VERSION__';
// Beta builds carry a fifth number, the beta count: 2.0.0.0.1 is shown as "2.0 beta 1" (the live build it's heading toward, then which beta)
const verLabel = v => { const p = String(v || '').split('.'); if (p.length < 5) return String(v || ''); const b = p.pop(); while (p.length > 2 && p[p.length - 1] === '0') p.pop(); return p.join('.') + ' beta ' + b; };
const SCRIPT_URL = 'https://raw.githubusercontent.com/Kirbeeman/bookshelfcalc/main/kindle-library-calculator.user.js';
const verLess = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
let scriptVer = '';
// The oldest sync script this page works with. Raise it only when a release changes the script itself;
// page-only releases leave it alone, so people aren't stopped for updates that don't touch their script.
const REQUIRED_SCRIPT = '__REQUIRED_SCRIPT__'; // filled in by build.py: the version where the script's code last changed
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
  ['2.2.0.0.3', ['Two filter boxes in Your library: Genre lists only main genres, Sub-genre lists the sub-genres that go with the genres you picked. Both are searchable and take several entries separated by commas', 'A book in a series takes its genre and tags from the other books in the series (or by the same author) before its title is guessed from: The Dungeon Anarchist\'s Cookbook is not a cookbook', 'GameLit & LitRPG is a main genre']],
  ['2.2.0.0.2', ['Tags are grouped as Parent › Sub-genre by the agreed genre rules: Dark Romance is Romance › Dark, Vampire Romances is Paranormal › Romance, Humorous Fantasy is Fantasy › Humorous, Contemporary Fantasy is Fantasy › Contemporary, and a tag with two genres follows the book\'s own main genre', 'Romantasy and Romantic Fantasy now count as Fantasy; Folklore joins Fairy Tales; Health joins Fitness & Dieting']],
  ['2.2.0.0.1', ['Genres and tags come only from each book\'s own Amazon category, never from the Best Sellers Rank lists (a dark romance was showing as Instructional): the first step is the main genre and the next two are its sub-genres. Every book gets one more look at its Amazon page', 'Tags that are really the same one are combined (Time Travel Romance and Time Travel Romances, GameLit & LitRPG and GameLit & LitRPG Fiction, Thriller & Suspense and Thrillers & Suspense, and the like)', 'The tag filter is searchable: click it for the whole list, or start typing to narrow it down. Separate tags or genres with commas to combine them ("fantasy, romance"); "romance" also finds Dark, Fantasy and Paranormal Romance']],
  ['2.1.1.1', ['Leave a book out by hand: click its title and tick "Leave this book out". It stays in your library (marked "left out") but not in the totals, value, charts or Shelf of Shame']],
  ['2.1.1.0', ['Signed code: the phone bookmark and the sync script only run code signed with the Shelf of Shame key. Set up the bookmark once more, and update the sync script once', 'A Content Security Policy on every page, and a getting-started guide for every device at /help', 'Up to 100 unread books on at most 3 shelves, with the decorations kept', 'Truer numbers: 99.5% instead of a rounded 100%, dictionaries and returned books left out, and no dictionary as your oldest unread book', 'Status dots in the same green, yellow and red in every theme']],
  ['2.1.0.0.10', ['Dictionaries stay out of the count even when a copy of your library from an older version (through Google Drive) brings them back as purchases']],
  ['2.1.0.0.9', ['Your oldest unread book is never a dictionary or user guide, even with Kindle extras counted']],
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
