# Turns the main build (gh/) into the beta test copy (beta/), served at betabookshelf.kirbee213.tv.
# Different address = separate browser storage, so the beta can never touch a real library.
import os, re, shutil
B=os.path.dirname(os.path.abspath(__file__)); G=B+'/bb'; O=B+'/beta'
def R(s,a,b,cnt=1):
    assert s.count(a)==cnt,(s.count(a),a[:60]); return s.replace(a,b)
html=open(G+'/index.html').read()
html=R(html,"const SCRIPT_URL = 'https://raw.githubusercontent.com/Kirbeeman/bookshelfcalc/main/kindle-library-calculator.user.js';",
 "const SCRIPT_URL = 'https://raw.githubusercontent.com/Kirbeeman/bookshelfcalc-beta/main/kindle-library-calculator-beta.user.js';")
html=R(html,'<div class="wrap">','<div class="betabar" role="note"><b>BETA</b> · test copy. Things may break here. Your real library is at <a href="https://bookshelf.kirbee213.tv/">bookshelf.kirbee213.tv</a> and is not affected.</div>\n<div class="wrap">')
html=html.replace('</style>','.betabar{background:repeating-linear-gradient(45deg,#f2c14e 0 14px,#e8b23a 14px 28px);color:#1b1206;font:600 .82rem/1.4 system-ui,sans-serif;text-align:center;padding:6px 12px;position:relative;z-index:50}.betabar a{color:inherit}\n</style>',1)
html=R(html,'<title>','<title>BETA · ')
us=open(G+'/kindle-library-calculator.user.js').read()
VER=re.search(r'@version\s+(\S+)', us).group(1)
us=R(us,'// @name         Shelf of Shame\n','// @name         Shelf of Shame (beta)\n')
us=R(us,'// @namespace    kindle-library-calculator\n','// @namespace    kindle-library-calculator-beta\n')
us=us.replace('https://raw.githubusercontent.com/Kirbeeman/bookshelfcalc/main/kindle-library-calculator.user.js','https://raw.githubusercontent.com/Kirbeeman/bookshelfcalc-beta/main/kindle-library-calculator-beta.user.js')
us=re.sub(r'// @match        https://(bookshelf\.kirbee213\.tv|kirbeeman\.github\.io/bookshelfcalc|www\.goodreads\.com|read\.amazon\.[a-z.]+/kindle-library)\S*\n','',us)
us=R(us,'// @connect      bookshelf.kirbee213.tv\n','// @connect      betabookshelf.kirbee213.tv\n')
us=R(us,"const SITE = 'https://bookshelf.kirbee213.tv/';","const SITE = 'https://betabookshelf.kirbee213.tv/';")
us=R(us,'// @connect      goodreads.com\n','// @match        https://betabookshelf.kirbee213.tv/*\n// @connect      goodreads.com\n')
os.makedirs(O,exist_ok=True)
html=R(html,'<meta property="og:image" content="https://bookshelf.kirbee213.tv/og.png?v='+VER+'">','<meta property="og:image" content="https://betabookshelf.kirbee213.tv/og.png?v='+VER+'">')
html=R(html,'<meta property="og:url" content="https://bookshelf.kirbee213.tv/">','<meta property="og:url" content="https://betabookshelf.kirbee213.tv/">')
open(O+'/index.html','w').write(html)
open(O+'/kindle-library-calculator-beta.user.js','w').write(us)
shutil.copy(G+'/bm.js', O+'/bm.js')
# the signed code and its signed release are the same files on both sites
shutil.copy(G+'/core.js', O+'/core.js'); shutil.copy(G+'/release.json', O+'/release.json')
shutil.copy(G+'/privacy.html', O+'/privacy.html')
shutil.copy(G+'/bookmark.html', O+'/bookmark.html')
# the iPhone guide, pointed at the beta site, at /iphone.html and /ioshelp
ios=open(G+'/iphone.html').read().replace('bookshelf.kirbee213.tv', 'betabookshelf.kirbee213.tv')
open(O+'/iphone.html','w').write(ios)
os.makedirs(O+'/ioshelp', exist_ok=True); open(O+'/ioshelp/index.html','w').write(ios)
hlp=open(G+'/help.html').read().replace('bookshelf.kirbee213.tv', 'betabookshelf.kirbee213.tv')
open(O+'/help.html','w').write(hlp); os.makedirs(O+'/help', exist_ok=True); open(O+'/help/index.html','w').write(hlp)
for f in ['icon-tag.png', 'icon-tag-180.png', 'icon-web.png', 'icon-web-180.png', 'og.png']: shutil.copy(G+'/'+f, O+'/'+f)
open(O+'/CNAME','w').write('betabookshelf.kirbee213.tv\n')
# the beta changes the page's script, so its fingerprint in the Content Security Policy is worked out again
import sys; sys.dont_write_bytecode = True; sys.path.insert(0, G+'/src'); import csp; csp.apply_all(O)
open(O+'/README.md','w').write("""# Shelf of Shame: beta

Test copy of the [Shelf of Shame](https://github.com/Kirbeeman/bookshelfcalc), served at **https://betabookshelf.kirbee213.tv**.

New features are tried out here before they go to the real site. Things may break.

- It's a different web address, so it keeps its own library in your browser. Your real library at bookshelf.kirbee213.tv is never touched.
- The beta sync script installs alongside the regular one and only runs on the beta site: [`kindle-library-calculator-beta.user.js`](kindle-library-calculator-beta.user.js).
- Built from the main repo's `src/` with the beta changes on top; the code that ships to everyone lives in the main repo.
""")
print('beta built')
