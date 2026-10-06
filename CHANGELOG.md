# Shelf of Shame beta changelog

Newest first. The latest beta is described in full; earlier ones are listed by title.

Beta versions are named for the live version they're heading toward, plus a beta count: "2.1 beta 1" is the first beta of what goes live as 2.1. (The script's internal version for that is 2.1.0.0.1.) 2.0 went live on October 6, 2026. Before this numbering, the beta used 1.51 to 1.55, which overlapped with live versions.

---

## 2.1 beta 2 (latest)

**Signed code: the sync only runs code Daniel signed** (set up the bookmark again; script update required)

- The **phone sync bookmark** now checks that the code it loads was signed with Daniel's signing key, and that the file matches exactly, before running anything. If either check fails it stops and says so. Set up the bookmark again once (Settings › Set up the bookmark); the old bookmark still works for now, but shows a note asking you to.
- The **sync script** is now a small loader that never changes. Each time it runs it checks the signed release and the script's code the same way, so updates arrive without reinstalling, but only signed ones. It keeps the last checked copy so it works offline, and never steps back to an older release. Your installed script switches to the loader with its usual update; after that, the loader itself never needs updating.
- Someone who got into the website or the GitHub repo still couldn't make either one run their own code.
- A **one-time notice** the first time you open this version: a thank-you, and a page on what's been done to keep your data safe. It follows your theme.
- Also in this beta (from 2.1 beta 1, not released on its own): every page carries a **Content Security Policy** (also live as 2.0.1), and there's a **getting-started guide for every device** at betabookshelf.kirbee213.tv/help.

---

## Earlier betas

- **2.1 beta 1** Security policy and a guide for every device (folded into beta 2)
- **2.0 beta 16** Your oldest unread book, named first (went live as 2.0)
- **2.0 beta 15** Phone sync bookmark fixed
- **2.0 beta 14** Cleaner titles from the sync script (script update required)
- **2.0 beta 13** Truer library value
- **2.0 beta 12** Computers build the library like phones do
- **2.0 beta 11** iPads get the phone setup
- **2.0 beta 10** The starting theme follows your device
- **2.0 beta 9** New theme: Fruit
- **2.0 beta 8** Behind-the-scenes cleanup
- **2.0 beta 7** Script updates are required when the script changes
- **2.0 beta 6** New icons show up straight away
- **2.0 beta 5** A bolder Halloween icon (the jack-o'-lantern book)
- **2.0 beta 4** An icon of its own
- **2.0 beta 3** Now called Shelf of Shame
- **2.0 beta 2** Easier bookmark setup, and a free script app on iPhone and iPad
- **2.0 beta 1** Version numbers in Settings, and tap outside to close
- **1.55** Faster on phones with big libraries
- 15-book phone shelf, and the globe always shows
- "Unknown" kept off the globe and the comic
- **1.54** Easier start on phones
- The "share of the spines" note under the genre key removed
- **1.53** Genres guessed from titles when Amazon has no page
- **1.52** Keep your library in your own Google Drive
- 10-book shelf on phones, with a globe and a comic for small genres
- Shorter sync bookmark for phones
- **1.51** Sync from a phone with a bookmark
- Beta test copy set up at betabookshelf.kirbee213.tv
