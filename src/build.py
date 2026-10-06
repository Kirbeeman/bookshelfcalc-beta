import re, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))  # run from anywhere: python3 src/build.py
src=open('base.html').read()
def R(s,a,b):
    assert s.count(a)==1, a[:70]; return s.replace(a,b)
# shared fixes (standalone + userscript)
src=R(src,"*{box-sizing:border-box}","*{box-sizing:border-box}\n[hidden]{display:none!important}")
src=R(src,"    if (m) {\n      for (const f of ['asin','author','pages','date'])",
 "    if (!m && !addNew) continue;\n    if (m) {\n      for (const f of ['asin','author','pages','date','isbn'])")
src=R(src,"        if (inc.status) m.status = inc.status;","        if (inc.status) m.status = inc.status;\n        if (kind === 'goodreads' && inc.progress != null && (inc.status !== 'reading' || !m.progress)) m.progress = inc.progress;")
src=R(src,"function merge(incoming, replace, kind) {","function merge(incoming, replace, kind, addNew = true) {")
src=R(src,"borrowed:false, samples:false}","borrowed:false, samples:false, grAll:false}")
src=R(src,'<label class="check full"><input type="checkbox" id="sSamples"> Count samples</label>',
 '<label class="check full"><input type="checkbox" id="sSamples"> Count samples</label>\n      <label class="check full" data-us><input type="checkbox" id="sGrAll"> Include Goodreads books that aren\'t in my Kindle library</label>')
src=R(src,"$('#sSamples').checked = s.samples;","$('#sSamples').checked = s.samples; $('#sGrAll').checked = !!s.grAll;")
src=R(src,"samples: $('#sSamples').checked,","samples: $('#sSamples').checked, grAll: $('#sGrAll').checked,")
# shared sync UI (hidden until a sync source is available: Tampermonkey core or the bridge on the website)
src=R(src,'      <button class="btn" id="btnAdd">Add book</button>',
 '      <button class="btn primary" id="btnSync" hidden>Sync now</button>\n      <button class="btn" id="btnAdd">Add book</button>')
src=R(src,'<div class="store st-none" id="store"><i></i><span>Example library</span></div>',
 '<div class="store st-none" id="store"><i></i><span>Example library</span></div>\n      <div class="store st-wait" id="sync" hidden><i></i><span>Not synced yet</span></div>')
src=R(src,"$('#btnImport').onclick = openImport; $('#bannerImport').onclick = openImport;",
 "$('#btnImport').onclick = openImport; $('#bannerImport').onclick = () => syncOn ? runSync(true) : openWizard('welcome');\n$('#btnSync').onclick = () => runSync(true);")
src=R(src,"renderAll();\ninitStore();","renderAll();\nstoreReady = initStore();\nstartSync();")
import re as _re
VER=_re.search(r'@version\s+(\S+)', open('template.user.js').read()).group(1)
src=src.replace('__SCRIPT_VERSION__', VER)  # icon addresses carry the version, so browsers fetch a changed icon
# The page requires the newest sync script only when the script's code changed. script-version.json remembers the code's
# fingerprint (everything but the @version line) and the version where it last changed; a new fingerprint makes this version required.
import hashlib as _hl, json as _js
_code=''.join(l for l in open('template.user.js').read().splitlines(True) if '@version' not in l)
_hash=_hl.sha256(_code.encode()).hexdigest()
_sv=_js.load(open('script-version.json'))
if _sv['hash'] != _hash:
    _sv={'hash': _hash, 'required': VER}; open('script-version.json','w').write(_js.dumps(_sv) + '\n')
    print('sync script changed: version', VER, 'is now required')
REQ=_sv['required']
# The phone sync bookmark: the shared Amazon readers from the userscript, wrapped and minified, kept in the page as a string
import json, subprocess
_tpl=open('template.user.js').read()
_core=_tpl[_tpl.index("// Amazon sends some titles and authors"):_tpl.index("const KLC_CORE = {")]  # from the title clean-up helper to the end of the shared readers
_bm=open('bookmarklet.src.js').read().replace('/*CORE*/', _core)
open('/tmp/klc-bm.js','w').write(_bm)
_min=subprocess.run(['terser','/tmp/klc-bm.js','--compress','--mangle','--ecma','2020'],capture_output=True,text=True,check=True).stdout.strip()
open('../bm.js','w').write(_min + '\n')
import shutil; shutil.copy('privacy.html', '../privacy.html'); open('../bookmark.html','w').write(open('bookmark.html').read().replace('__SIGN_KEY__', open('signing-key.pub').read().strip())); shutil.copy('iphone.html', '../iphone.html'); os.makedirs('../ioshelp', exist_ok=True); shutil.copy('iphone.html', '../ioshelp/index.html'); shutil.copy('help.html', '../help.html'); os.makedirs('../help', exist_ok=True); shutil.copy('help.html', '../help/index.html')
for _f in ['icon-tag.png', 'icon-tag-180.png', 'icon-web.png', 'icon-web-180.png', 'og.png']: shutil.copy(_f, '../' + _f)  # drawn by icons/make_icons.js  # served next to the page; the bookmark itself just loads this file
_sync=(open('sync.js').read() + '\n' + open('drive.js').read()).replace('__SCRIPT_VERSION__', VER).replace('__REQUIRED_SCRIPT__', REQ).replace('__SIGN_KEY__', open('signing-key.pub').read().strip())
src=R(src,"// ---------- export ----------", _sync+"\n// ---------- export ----------")
standalone=src.replace('<label class="check full" data-us>','<label class="check full" data-us hidden>')
for out_path in ('../index.html', '../BookshelfCalc/index.html'):
    open(out_path,'w').write(standalone)
# every page gets its Content Security Policy (csp.py), after all pages are written
import sys as _sys; _sys.dont_write_bytecode = True  # no __pycache__ folder in the repo
import csp as _csp; _csp.apply_all('..')

css=re.search(r'<style>(.*?)</style>',src,re.S).group(1)
body=src[src.index('<div class="wrap">'):src.index('<script>')]
js=re.search(r'<script>\n\(\(\) => \{(.*)\}\)\(\);\n</script>',src,re.S).group(1)

# userscript-specific
body=R(body,'Install the free sync script and your own Kindle library replaces it automatically. Your books are saved in this browser only.',
 'Your first sync replaces it with your Kindle library and Goodreads shelves.')
body=body.replace('<label class="check full" data-us>','<label class="check full">')
js=R(js,"const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } };",
 "const lsGet = () => { try { return JSON.parse(GM_getValue(LS, 'null')); } catch { return null; } };")
js=R(js,"const lsSet = v => { try { localStorage.setItem(LS, JSON.stringify(v)); return true; } catch { return false; } };",
 "const lsSet = v => { try { GM_setValue(LS, JSON.stringify(v)); return true; } catch { return false; } };")
tpl=open('template.user.js').read()
out=tpl.replace('/*CSS*/',css.replace('\\','\\\\').replace('`','\\`').replace('${','\\${')).replace('/*BODY*/',body.replace('\\','\\\\').replace('`','\\`').replace('${','\\${')).replace('/*CALC*/',js)
# core.js: the sync script's code on its own, starting at "(function", for the signed loader to check and run
open('../core.js','w').write(out[out.index('(function (GM_getValue'):])
# the loader people install: never updates itself, only runs core.js from a signed release
_key=open('signing-key.pub').read().strip()
_ld=open('loader.user.js').read().replace('__VERSION__', VER).replace('__SIGN_KEY__', _key)
open('../kindle-library-calculator.user.js','w').write(_ld)
# signed release: stops the build if bm.js or core.js changed and the new release text isn't signed yet
import signing as _signing
print('signed release', _signing.release('..', VER))
print('built', len(out))
