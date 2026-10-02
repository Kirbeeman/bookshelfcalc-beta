# Beta source files

The files the beta site is built from. The real site's sources live in the main repo's `src/`.

| File | What it is |
| --- | --- |
| `base.html` | The page: layout, styles, shelf, stats, library table |
| `sync.js` | Talking to the sync script, the phone sync bookmark's receiver, Settings sections |
| `drive.js` | The Google Drive connection and the book-by-book merge |
| `bookmarklet.src.js` | The phone sync bookmark's code, served as `bm.js` |
| `template.user.js` | The Tampermonkey sync script (its `@version` is also the page version) |
| `privacy.html` | The privacy page |
| `build.py` | Builds the regular site files from these (needs `terser` for `bm.js`) |
| `make_beta.py` | Turns that build into the beta copy: BETA banner, beta script name and addresses, CNAME |

## Rebuilding

1. Make a work folder with these files in `work/src/`.
2. `python3 work/src/build.py` writes the regular build into `work/`.
3. Set `G` in `make_beta.py` to `work/` and `O` to a clone of this repo, then run it.
