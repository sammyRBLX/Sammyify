const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { Client } = require('@xhayper/discord-rpc');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- Settings ----------
const DISCORD_CLIENT_ID = '1575213800112787566'; // Application ID from the Discord Developer Portal
const AUTO_UPDATE = false;                        // set true + use an installer build to enable updates
const PORT = 8765;                                // Spotify/YouTube need http://127.0.0.1, not file://
const LARGE_IMAGE_FALLBACK = 'sammyify';          // Art asset key uploaded in Discord Developer Portal

// ---------- Single instance ----------
if (!app.requestSingleInstanceLock()) app.quit();

let win;

// ---------- Local server (serves index.html at http://127.0.0.1:8765) ----------
function startServer() {
  return new Promise((resolve) => {
    const html = () => fs.readFileSync(path.join(__dirname, 'index.html'));
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html());
    });
    server.on('error', () => server.listen(0, '127.0.0.1')); // port busy -> pick a free one
    server.on('listening', () => resolve(server.address().port));
    server.listen(PORT, '127.0.0.1');
  });
}

async function createWindow() {
  const port = await startServer();
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#080b10',
    autoHideMenuBar: true,
    title: 'Sammyify',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

// ---------- Discord Rich Presence ("Listening to Sammyify") ----------
let rpc = null;
let rpcReady = false;
let lastPayload = null;
let retryTimer = null;

function connectDiscord() {
  clearTimeout(retryTimer);
  rpc = new Client({ clientId: DISCORD_CLIENT_ID });
  rpc.on('ready', () => {
    rpcReady = true;
    if (lastPayload) setPresence(lastPayload);
  });
  rpc.on('disconnected', () => {
    rpcReady = false;
    retryTimer = setTimeout(connectDiscord, 15000);
  });
  rpc.login().catch(() => {
    rpcReady = false;
    retryTimer = setTimeout(connectDiscord, 15000); // Discord not open yet - keep trying
  });
}

const clip = (s, fallback) => {
  s = String(s || fallback || '').trim();
  if (s.length < 2) s = fallback || '--';
  return s.slice(0, 128);
};

// ---- Album art lookup (Discord needs a public image URL, local files have none) ----
const artCache = new Map(); // key -> { url, album } | null
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cleanTitle = (s) =>
  String(s || '')
    .replace(/^\d{1,3}[\s._-]+/, '')
    .replace(/_+/g, ' ')
    .replace(/\s*[\(\[][^)\]]*(feat|ft\.|remaster|live|version|official|lyric|audio|video)[^)\]]*[\)\]]/gi, '')
    .trim();

async function findArt(title, artist, album) {
  const key = norm(artist) + '|' + norm(title);
  if (artCache.has(key)) return artCache.get(key);
  let result = null;
  try {
    const term = `${cleanTitle(title)} ${artist || ''}`.trim();
    const r = await fetch(
      'https://itunes.apple.com/search?' + new URLSearchParams({ term, entity: 'song', limit: '10' })
    );
    if (r.ok) {
      const items = (await r.json()).results || [];
      const t = norm(cleanTitle(title)), a = norm(artist), al = norm(album);
      const score = (i) =>
        (norm(i.trackName) === t ? 4 : norm(i.trackName).includes(t) || t.includes(norm(i.trackName)) ? 2 : 0) +
        (a && norm(i.artistName).includes(a) ? 3 : 0) +
        (al && norm(i.collectionName).includes(al) ? 2 : 0);
      const best = items.filter((i) => i.artworkUrl100).sort((x, y) => score(y) - score(x))[0];
      if (best && score(best) >= 2) {
        result = { url: best.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.'), album: best.collectionName };
      }
    }
  } catch {}
  artCache.set(key, result);
  return result;
}

let current = null; // { key, activity } for the song being shown

function setPresence(p) {
  lastPayload = p;
  if (!rpc || !rpcReady) return;
  if (!p || !p.title || p.paused) {
    current = null;
    rpc.user?.clearActivity().catch(() => {});
    return;
  }
  const key = norm(p.artist) + '|' + norm(p.title);
  const start = new Date(Date.now() - Math.max(0, p.position || 0) * 1000);
  const cached = artCache.get(key);
  const hasUrl = /^https?:\/\//.test(p.cover || '');
  const activity = {
    type: 2, // 2 = Listening (the Spotify-style "Listening to ..." card)
    details: clip(p.title, 'Unknown title'),
    state: clip(p.artist, 'Unknown artist'),
    largeImageKey: hasUrl ? p.cover : cached ? cached.url : LARGE_IMAGE_FALLBACK,
    largeImageText: clip(p.album || (cached && cached.album), 'Sammyify'),
    startTimestamp: start,
    instance: false,
  };
  if (p.duration && isFinite(p.duration) && p.duration > 0) {
    activity.endTimestamp = new Date(start.getTime() + p.duration * 1000); // progress bar
  }
  current = { key, activity };
  rpc.user?.setActivity(activity).catch(() => {});

  // Not found yet: fetch the cover, then update the same card (same timestamps)
  if (!hasUrl && !artCache.has(key)) {
    findArt(p.title, p.artist, p.album).then((art) => {
      if (!art || !current || current.key !== key || !rpcReady) return;
      current.activity.largeImageKey = art.url;
      if (!p.album) current.activity.largeImageText = clip(art.album, 'Sammyify');
      rpc.user?.setActivity(current.activity).catch(() => {});
    });
  }
}

ipcMain.on('presence', (_e, data) => setPresence(data));

// ---------- Auto-update (GitHub Releases) ----------
function setupAutoUpdate() {
  if (!app.isPackaged) return; // only in the installed app
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        title: 'Update ready',
        message: `Sammyify ${info.version} has been downloaded.`,
        detail: 'Restart to finish updating. It will also install next time you close the app.',
      })
      .then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', (err) => console.error('Updater error:', err == null ? 'unknown' : err.message));

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000);
}

// ---------- App lifecycle ----------
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  await createWindow();
  connectDiscord();
  if (AUTO_UPDATE) setupAutoUpdate();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { rpc?.destroy(); } catch {} });
