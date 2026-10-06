# Content Security Policy for every page: browsers then run only this site's own code (the page's one inline script,
# matched by its fingerprint) and Google's sign-in script, and only talk to this site, Google Fonts and Google Drive.
import base64, hashlib, re

# The calculator pages also allow 'unsafe-eval': the sync script's loader checks the signed core.js and then has to turn
# that checked text into code, and in Tampermonkey the page's policy applies to the script too. The page itself never
# evaluates text, and injected scripts are still refused.
EVAL_PAGES = {'index.html', 'BookshelfCalc/index.html'}

def add_csp(html, allow_eval=False):
    html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>\n', '', html)
    hashes = ' '.join("'sha256-%s'" % base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()
                      for s in re.findall(r'<script>(.*?)</script>', html, re.S))
    ev = "'unsafe-eval' " if allow_eval else ''
    policy = ("default-src 'self'; "
              f"script-src 'self' {ev}{hashes} https://accounts.google.com/gsi/client; ".replace('  ', ' ') +
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style; "
              "font-src https://fonts.gstatic.com; "
              "img-src 'self' data: blob:; "
              "connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com; "
              "frame-src https://accounts.google.com; "
              "object-src 'none'; base-uri 'self'; form-action 'self'")
    assert html.count('<meta charset="utf-8">') == 1
    return html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="%s">' % policy, 1)

PAGES = ['index.html', 'BookshelfCalc/index.html', 'privacy.html', 'bookmark.html', 'iphone.html', 'ioshelp/index.html', 'help.html', 'help/index.html']

def apply_all(root):
    import os
    for p in PAGES:
        f = os.path.join(root, p)
        if os.path.exists(f):
            html = add_csp(open(f).read(), p in EVAL_PAGES)  # read first: opening for writing empties the file
            open(f, 'w').write(html)
