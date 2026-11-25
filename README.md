# Sammyify
Personal music player. Edit `index.html`, push to GitHub, and:
- the **website** updates automatically (GitHub Pages)
- a fresh **Sammyify.exe** is built automatically (Releases when you push a `v*` tag)

## Releasing an update (auto-update)
```
git tag v1.0.1
git push origin v1.0.1
```
GitHub Actions builds the installer and publishes a Release. Installed copies of Sammyify check for new releases on launch (and every 30 min), download them, and offer to restart.

## Discord "Listening to" status
Runs in the desktop app while Discord is open. Upload an image named `sammyify` in the
Discord Developer Portal -> your app -> Rich Presence -> Art Assets to use as the cover.

## Run locally
```
npm install
npm start
```
