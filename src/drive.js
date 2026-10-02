// ---------- Google Drive (optional): the library kept in one file in the user's own Drive ----------
// The page talks to Google straight from the browser. The permission ("drive.file") only reaches files this site created,
// and the sign-in token lives in this tab's memory. Nothing goes through any server of ours.
const GD_CLIENT = '415875336210-7sqa3p2evj9on6be8vu7pal417g39hme.apps.googleusercontent.com';
const GD_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GD_NAME = 'Kindle Library Calculator.json';
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
async function gdFind() {
  const id = gdGet('klc-gd-file'), F = 'id,modifiedTime,trashed';
  if (id) { const r = await gapi('GET', `https://www.googleapis.com/drive/v3/files/${id}?fields=${F}`); if (r) { const f = await r.json(); if (!f.trashed) return f; } }
  const q = encodeURIComponent(`name = '${GD_NAME}' and trashed = false`);
  const r = await gapi('GET', `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(${F})`);
  const f = r && (await r.json()).files?.[0];
  if (f) gdSet('klc-gd-file', f.id);
  return f || null;
}
async function gdWrite(id, obj) {
  const data = JSON.stringify(obj);
  let r;
  if (id) r = await gapi('PATCH', `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&fields=id,modifiedTime`, data, 'application/json');
  if (!r) {
    const b = 'klc' + Date.now();
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name: GD_NAME, mimeType: 'application/json', description: 'Your Kindle Library Calculator library (bookshelf.kirbee213.tv). Delete it any time.'})}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${data}\r\n--${b}--`;
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
  if (!gdOn() || gdApplying || S.demo || libHash(S.books) === gd.lastHash) return;
  clearTimeout(gd.timer); gd.timer = setTimeout(() => syncDrive(false), 4000);
}
function gdStatus(state) {
  gd.state = state;
  let el = document.getElementById('gdStore');
  if (!el) { el = document.createElement('button'); el.type = 'button'; el.id = 'gdStore'; el.className = 'store gdstore'; el.onclick = () => syncDrive(true); $('#store').after(el); }
  el.hidden = !gdOn() && state !== 'run';
  const t = gd.when ? new Date(gd.when).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : '';
  el.dataset.k = state;
  el.innerHTML = '<i></i>' + (state === 'run' ? 'Google Drive: syncing…' : state === 'ok' ? `Google Drive: synced ${t}` : state === 'err' ? 'Google Drive: problem, tap to retry' : 'Google Drive: tap to sync');
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
