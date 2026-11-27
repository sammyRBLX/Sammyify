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
const GITHUB_REPO = 'sammyRBLX/Sammyify';          // checked for newer releases
const LARGE_IMAGE_FALLBACK = 'sammyify';          // Art asset key uploaded in Discord Developer Portal

// ---------- Single instance ----------
if (!app.requestSingleInstanceLock()) app.quit();

// Makes Windows use our icon (and not Electron's atom) on the taskbar
app.setAppUserModelId('com.sammyify.app');

// NOTE: electron-builder strips the "build/" folder from the app, so the runtime icons live in "assets/"
const ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const MIN_SPLASH_MS = 1800; // splash is always visible at least this long

let win;
let splash;

// Videos are unpacked from the asar (see package.json "asarUnpack") so they are real files on disk
const videoPath = (name) => {
  const p = path.join(__dirname, 'videos', name);
  const unpacked = p.replace('app.asar', 'app.asar.unpacked');
  return fs.existsSync(unpacked) ? unpacked : p;
};

// ---------- Local server (serves index.html at http://127.0.0.1:8765) ----------
function startServer() {
  return new Promise((resolve) => {
    const html = () => fs.readFileSync(path.join(__dirname, 'index.html'));
    const server = http.createServer((req, res) => {
      // Background videos (videos/*.mp4) - supports Range requests so playback/seeking works
      const m = /^\/videos\/([\w.-]+\.mp4)$/.exec((req.url || '').split('?')[0]);
      if (m) {
        try {
          const buf = fs.readFileSync(videoPath(m[1]));
          const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
          const base = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=86400' };
          if (r && (r[1] || r[2])) {
            let start = r[1] ? parseInt(r[1], 10) : Math.max(0, buf.length - parseInt(r[2], 10));
            let end = r[1] && r[2] ? Math.min(parseInt(r[2], 10), buf.length - 1) : buf.length - 1;
            if (start > end || start >= buf.length) {
              res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` });
              return res.end();
            }
            res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 });
            return res.end(buf.subarray(start, end + 1));
          }
          res.writeHead(200, { ...base, 'Content-Length': buf.length });
          return res.end(buf);
        } catch {
          res.writeHead(404);
          return res.end();
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html());
    });
    server.on('error', () => server.listen(0, '127.0.0.1')); // port busy -> pick a free one
    server.on('listening', () => resolve(server.address().port));
    server.listen(PORT, '127.0.0.1');
  });
}

function createSplash() {
  splash = new BrowserWindow({
    width: 440,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    show: false,
    icon: ICON,
    title: 'Sammyify',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => { if (splash && !splash.isDestroyed()) splash.show(); });
  splash.on('closed', () => { splash = null; });
}

async function createWindow() {
  const splashStart = Date.now();
  createSplash();

  const port = await startServer();
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false, // stays hidden until the page is ready, the splash covers the wait
    backgroundColor: '#07121c',
    autoHideMenuBar: true,
    title: 'Sammyify',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setIcon(ICON);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  let shown = false;
  const reveal = () => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    win.show();
    win.focus();
    if (splash && !splash.isDestroyed()) splash.close();
  };
  // Show the main window once the page has loaded AND the splash has been up long enough
  win.webContents.once('did-finish-load', () => {
    setTimeout(reveal, Math.max(0, MIN_SPLASH_MS - (Date.now() - splashStart)));
  });
  setTimeout(reveal, 15000); // failsafe: never get stuck on the splash

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

// ---------- "Is there a newer release on GitHub?" ----------
// On launch (and every 6 hours) the app asks GitHub for the latest Release. If its version is higher than
// this app's version, a box asks whether to open the GitHub page. Silent when offline / no releases yet.
const SKIP_FILE = () => path.join(app.getPath('userData'), 'skipped-version.txt');
const parseVer = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(latest, current) {
  const a = parseVer(latest), b = parseVer(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}
let updateAsked = false;
async function checkForNewRelease() {
  if (updateAsked || !win || win.isDestroyed()) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'Sammyify', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return;
    const rel = await r.json();
    const latest = rel.tag_name;
    if (!latest || !isNewer(latest, app.getVersion())) return;
    let skipped = '';
    try { skipped = fs.readFileSync(SKIP_FILE(), 'utf8').trim(); } catch {}
    if (skipped === latest) return;
    updateAsked = true;
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Open GitHub page', 'Later', 'Skip this version'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `A new version of Sammyify is available (${latest}).`,
      detail: `You have ${app.getVersion()}. Open the GitHub page to download the newest ${latest}?`,
    });
    if (response === 0) shell.openExternal(rel.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`);
    else if (response === 2) { try { fs.writeFileSync(SKIP_FILE(), latest); } catch {} }
    else updateAsked = false; // "Later": ask again at the next check
  } catch {} // offline, rate-limited, etc. - just try again later
}

// ---------- App lifecycle ----------
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  await createWindow();
  connectDiscord();
  if (AUTO_UPDATE) setupAutoUpdate();
  else if (app.isPackaged) {
    setTimeout(checkForNewRelease, 4000);
    setInterval(checkForNewRelease, 6 * 60 * 60 * 1000);
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { rpc?.destroy(); } catch {} });
