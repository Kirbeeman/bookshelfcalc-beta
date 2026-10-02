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
src=R(src,'<div class="store demo" id="store"><i></i><span>Example library</span></div>',
 '<div class="store demo" id="store"><i></i><span>Example library</span></div>\n      <div class="store" id="sync" hidden><span>Not synced yet</span></div>')
src=R(src,"$('#btnImport').onclick = openImport; $('#bannerImport').onclick = openImport;",
 "$('#btnImport').onclick = openImport; $('#bannerImport').onclick = () => syncOn ? runSync(true) : openWizard('welcome');\n$('#btnSync').onclick = () => runSync(true);")
src=R(src,"renderAll();\ninitStore();","renderAll();\nstoreReady = initStore();\nstartSync();")
import re as _re
VER=_re.search(r'@version\s+(\S+)', open('template.user.js').read()).group(1)
# The phone sync bookmark: the shared Amazon readers from the userscript, wrapped and minified, kept in the page as a string
import json, subprocess
_tpl=open('template.user.js').read()
_core=_tpl[_tpl.index("// Purchase dates (and Kindle"):_tpl.index("const KLC_CORE = {")]
_bm=open('bookmarklet.src.js').read().replace('/*CORE*/', _core)
open('/tmp/klc-bm.js','w').write(_bm)
_min=subprocess.run(['terser','/tmp/klc-bm.js','--compress','--mangle','--ecma','2020'],capture_output=True,text=True,check=True).stdout.strip()
open('../bm.js','w').write(_min + '\n')
import shutil; shutil.copy('privacy.html', '../privacy.html')  # served next to the page; the bookmark itself just loads this file
_sync=(open('sync.js').read() + '\n' + open('drive.js').read()).replace('__SCRIPT_VERSION__', VER)
src=R(src,"// ---------- export ----------", _sync+"\n// ---------- export ----------")
standalone=src.replace('<label class="check full" data-us>','<label class="check full" data-us hidden>')
for out_path in ('../index.html', '../BookshelfCalc/index.html'):
    open(out_path,'w').write(standalone)

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
open('../kindle-library-calculator.user.js','w').write(out)
print('built', len(out))
