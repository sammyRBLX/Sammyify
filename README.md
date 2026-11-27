# Sammyify
Personal music player. Edit `index.html`, push to GitHub, and:
- the **website** updates automatically (GitHub Pages)
- a fresh **Sammyify.exe** is built automatically (Releases when you push a `v*` tag)

## Releasing a new version
```
git tag v1.0.1
git push origin v1.0.1
```
(or on GitHub: Releases -> Draft a new release -> create tag `v1.0.1` -> Publish)

GitHub Actions builds `Sammyify.exe` with that version number and attaches it to a Release.
The desktop app checks GitHub for the latest Release when it starts (and every 6 hours). If it is newer than the
version you're running, it asks **Open GitHub page / Later / Skip this version**. (Only the installed `.exe` checks;
`npm start` doesn't. To change which repo is checked, edit `GITHUB_REPO` at the top of `main.js`.)

## Discord "Listening to" status
Runs in the desktop app while Discord is open. Upload an image named `sammyify` in the
Discord Developer Portal -> your app -> Rich Presence -> Art Assets to use as the cover.

## Run locally
```
npm install
npm start
```

## Community added
The **Community added** tab on Discover lists songs uploaded by everyone using the app (filter by uploader with the name chips), stored in Supabase
(table `songs`, public storage bucket `music`). Friends upload with **＋ Upload songs** — no accounts.
To remove a song, delete it in the Supabase dashboard (Table Editor -> songs, Storage -> music).

### Auto-correct for community songs
On upload the app reads the file's tags and cover art, then fixes artist/album/cover from iTunes.
Songs uploaded before this existed are fixed in the background (a few per visit).
Run `supabase-update.sql` once in Supabase to store the extra info for everyone.

### Edit / delete your own uploads
Each upload gets a secret token kept in this browser/app (`sammyify-owned` in local storage); only its hash is stored in the database.
Open a song's `···` menu to edit its name/artist or delete it. Titles, artists and names are passed through a word filter (`cleanWords` in index.html; change `SB_REPLACEMENT` to use a different replacement word).
Songs uploaded before this feature have no owner — delete those from the Supabase dashboard.

## Look & feel
The UI is a single `index.html` (the desktop app serves only that file, so keep CSS/JS inline).
It uses the Runtime Studios style: top nav, centred hero + stat boxes, glow-on-hover cards, Archivo/Inter fonts (Google Fonts; falls back to system fonts offline).
All colours come from the theme variables at the top of the `<style>` block, so the themes in Settings still work.

The **website** gets custom progress/volume bars (`html.web input[type=range]` in the CSS); the **desktop app** keeps the native bars.
`index.html` tags the page with `class="web"` or `class="app"` (the app is detected through `window.sammify` from `preload.js`).
To use the custom bars in the app too, change `html.web input[type=range]` to `input[type=range]` in the CSS.
