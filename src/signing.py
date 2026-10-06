# Signed releases. The phone bookmark and the sync script loader only run bm.js and core.js when they match a release text
# signed with the Shelf of Shame signing key, which only Daniel holds (it never touches this repo). The build works out the
# release text; when bm.js or core.js changed, it stops until that text has been signed on the signing page.
import base64, hashlib, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = open(os.path.join(HERE, 'signing-key.pub')).read().strip()
SIGNED = os.path.join(HERE, 'release.json')          # {"text": <signed text>, "sig": <signature>}, kept in the repo
PENDING = os.path.join(HERE, 'release.pending.txt')  # the text waiting to be signed

def fingerprint(path):
    return 'sha384-' + base64.b64encode(hashlib.sha384(open(path, 'rb').read()).digest()).decode()

def genuine(text, sig):
    js = ("const c=require('crypto');const k=c.createPublicKey({key:Buffer.from(process.argv[1],'base64'),format:'der',type:'spki'});"
          "process.exit(c.verify('sha256',Buffer.from(process.argv[2]),{key:k,dsaEncoding:'ieee-p1363'},Buffer.from(process.argv[3],'base64'))?0:1)")
    return subprocess.run(['node', '-e', js, KEY, text, sig]).returncode == 0

def release(out_dir, version):
    files = {'bm.js': fingerprint(os.path.join(out_dir, 'bm.js')), 'core.js': fingerprint(os.path.join(out_dir, 'core.js'))}
    signed = json.load(open(SIGNED)) if os.path.exists(SIGNED) else None
    if signed and json.loads(signed['text'])['files'] == files and genuine(signed['text'], signed['sig']):
        open(os.path.join(out_dir, 'release.json'), 'w').write(json.dumps(signed) + '\n')
        if os.path.exists(PENDING): os.remove(PENDING)
        return json.loads(signed['text'])['version']
    text = json.dumps({'app': 'shelf-of-shame', 'version': version, 'files': files}, separators=(',', ':'))
    open(PENDING, 'w').write(text + '\n')
    sys.exit('\nNEEDS SIGNING: bm.js or core.js changed. Sign this text on the signing page, then save it with\n'
             '  python3 src/signing.py save <signature>\n\n' + text + '\n')

def save(sig):
    text = open(PENDING).read().strip()
    if not genuine(text, sig.strip()): sys.exit('That signature does not match the release text and the signing key.')
    open(SIGNED, 'w').write(json.dumps({'text': text, 'sig': sig.strip()}) + '\n'); os.remove(PENDING)
    print('Signature saved. Run the build again.')

if __name__ == '__main__' and sys.argv[1:2] == ['save']:
    save(sys.argv[2])
