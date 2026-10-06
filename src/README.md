# Beta source files

The files the beta site is built from. The real site's sources live in the main repo's `src/`.

| File | What it is |
| --- | --- |
| `base.html` | The page: layout, styles, shelf, stats, library table |
| `sync.js` | Talking to the sync script, the phone sync bookmark's receiver, Settings sections |
| `drive.js` | The Google Drive connection and the book-by-book merge |
| `bookmarklet.src.js` | The phone sync bookmark's code, served as `bm.js` |
| `template.user.js` | The sync script's own code, built into `core.js` (its `@version` is also the page version) |
| `loader.user.js` | The sync script people install: it never updates itself, and only runs `core.js` from a signed release |
| `signing-key.pub` | The public half of the Shelf of Shame signing key (the private half never comes near this repo) |
| `signing.py` | Works out the release text, checks signatures, and saves a new one |
| `release.json` | The current signed release: the release text and its signature |
| `csp.py` | Adds the Content Security Policy to every page |
| `help.html`, `iphone.html` | The getting-started guides, served at /help and /ioshelp |
| `privacy.html` | The privacy page |
| `build.py` | Builds the regular site files from these (needs `terser` for `bm.js`) |
| `make_beta.py` | Turns that build into the beta copy: BETA banner, beta script name and addresses, CNAME |

## Rebuilding

1. Make a work folder with these files in `work/src/`.
2. `python3 work/src/build.py` writes the regular build into `work/`.
3. Set `G` in `make_beta.py` to `work/` and `O` to a clone of this repo, then run it.

## Signed releases

The phone bookmark and the sync script only run `bm.js` and `core.js` when they match a release text signed with Daniel's signing key. When either file changes:

1. The build stops with **NEEDS SIGNING** and prints the release text (also saved as `src/release.pending.txt`).
2. Daniel signs it on the Shelf of Shame signing page ("Sign a release": the text, his key file and passphrase).
3. `python3 src/signing.py save <signature>` checks the signature and saves `src/release.json`.
4. Run the build again; it copies the signed `release.json` next to the site files.

The key file and passphrase stay with Daniel (signing folder plus password manager). If the key is ever lost, a new one means everyone sets up the bookmark and installs the script again once.
