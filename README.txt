# Sammyify Discord Rich Presence patch

This patch adds Discord Rich Presence to the Electron desktop build.

## Files
- `main.js`: Electron main process, Discord RPC connection, and activity updates.
- `preload.js`: secure bridge between the web player and Electron.
- `package.json`: adds `discord-rpc` and packages `preload.js`.
- `index.patch`: small patch to connect the existing player state to the bridge.

## Apply
1. Replace the repository's `main.js` with this folder's `main.js`.
2. Add `preload.js` to the repository root.
3. Replace `package.json` with this folder's `package.json` (or merge the discord-rpc dependency, preload.js build file, and existing build settings).
4. Apply `index.patch` to `index.html`. If you edit manually, insert the `syncDiscordPresence()` function after `getTrack()` and make the two playback-event replacements shown in the patch.
5. In Discord Developer Portal > your app > Rich Presence > Art Assets, upload the Sammyify logo with the asset key exactly `sammyify_logo`.
6. Confirm the Application ID in `main.js` matches your Discord app. The value included here was read from the screenshot you supplied.
7. Commit the changes to `main`.

The GitHub Actions build will install `discord-rpc` through `npm install` and package the preload file.

## Artwork limitation
Classic Discord Rich Presence uses artwork uploaded to the Developer Portal as named assets. It cannot display each user's arbitrary local album-cover file as Spotify does. This setup uses the Sammyify logo as the large image while still changing the track title, artist, album text, pause state, and timestamps.

## Auto-updates
This does NOT add automatic updating to already-installed copies. Your current GitHub workflow builds an artifact; it does not install an updater into the EXE. Also, the current build target is `portable`. For standard Electron automatic updates, the project should move to an installer target such as NSIS and publish signed/versioned releases. Do not assume an existing portable EXE will update itself when you push to GitHub.
