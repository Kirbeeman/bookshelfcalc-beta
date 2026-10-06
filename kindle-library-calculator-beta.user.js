// ==UserScript==
// @name         Shelf of Shame (beta)
// @namespace    kindle-library-calculator-beta
// @version      2.1.0.0.4
// @downloadURL  none
// @description  Library value, reading time and a Shelf of Shame for your Kindle books, kept in sync with your Goodreads shelves.
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
// @connect      betabookshelf.kirbee213.tv
// @match        https://betabookshelf.kirbee213.tv/*
// @connect      goodreads.com
// @connect      amazon.com
// @connect      amazon.co.uk
// @connect      amazon.ca
// @connect      amazon.com.au
// @run-at       document-end
// @sandbox      DOM
// @inject-into  content
// ==/UserScript==

// This loader never updates itself (@downloadURL none). Each time it runs it fetches the latest release, checks it was
// signed with the Shelf of Shame signing key below, checks core.js matches the signed fingerprint, and only then runs it.
// Someone who took over the website or the GitHub repo still couldn't make it run anything that wasn't signed.
(async () => {
const SITE = 'https://betabookshelf.kirbee213.tv/';
const KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEy1ISS5hsqAzzd9MIDHiLbPEZm3j2D+m31Beqg+ylcGEk6q8Mh6iibJJ5G5dH0GdUVwClChtOexlh5jd7fy9h2g==';
const TM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
const cache = {};
if (!TM && typeof GM !== 'undefined' && GM.getValue) {
  let keys = ['grUser', 'kindle', 'kindleHost', 'owned', 'prices', 'klc-signed'];
  try { if (GM.listValues) keys = [...new Set([...keys, ...await GM.listValues()])]; } catch {}
  for (const k of keys) { try { const v = await GM.getValue(k); if (v !== undefined) cache[k] = v; } catch {} }
}
const api = TM ? [GM_getValue, GM_setValue] : [(k, d) => k in cache ? cache[k] : d, (k, v) => { cache[k] = v; try { GM.setValue(k, v); } catch {} }];
api.push(typeof GM_addStyle === 'function' ? GM_addStyle : css => { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); return st; });
api.push(typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : d => GM.xmlHttpRequest(d));
api.push(typeof GM_info !== 'undefined' ? GM_info : GM.info);
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const utf8 = s => new TextEncoder().encode(s);
const get = url => new Promise((ok, bad) => api[3]({method: 'GET', url, timeout: 30000,
  onload: r => r.status === 200 ? ok(r.responseText) : bad(new Error('HTTP ' + r.status)), onerror: () => bad(new Error('network')), ontimeout: () => bad(new Error('timeout'))}));
const genuine = async rel => {
  const k = await crypto.subtle.importKey('spki', b64(KEY), {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
  return crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, k, b64(rel.sig), utf8(rel.text));
};
const fingerprint = async text => 'sha384-' + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-384', utf8(text)))));
const stop = why => { console.warn('[Shelf of Shame] Not running: ' + why); };
let saved = null; try { saved = JSON.parse(api[0]('klc-signed', 'null')); } catch {}
let rel = null;
try { rel = JSON.parse(await get(SITE + 'release.json?' + Date.now())); } catch { rel = saved && saved.rel; } // offline: the last signed release
if (!rel || !(await genuine(rel).catch(() => false))) return stop('the release is not signed with the Shelf of Shame key');
// never step back to an older signed release than the one already checked here (someone could re-serve an old one)
const older = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
if (saved && saved.rel !== rel && older(JSON.parse(rel.text).version, JSON.parse(saved.rel.text).version)) rel = saved.rel;
const m = JSON.parse(rel.text), want = m.files['core.js'];
let code = saved && saved.hash === want ? saved.code : null;
if (!code) { try { code = await get(SITE + 'core.js?v=' + encodeURIComponent(m.version)); } catch (e) { return stop('could not download core.js (' + e.message + ')'); } }
if (await fingerprint(code) !== want) return stop('core.js does not match the signed release');
if (!saved || saved.hash !== want || saved.rel.text !== rel.text) api[1]('klc-signed', JSON.stringify({rel, hash: want, code}));
let run; try { run = new Function('return ' + code)(); } catch (e) { return stop('this page does not allow it (' + e.message.slice(0, 80) + ')'); }
run(api[0], api[1], api[2], api[3], {script: {name: 'Shelf of Shame', version: m.version}}, SITE);
})();
