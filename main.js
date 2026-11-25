const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const DiscordRPC = require('discord-rpc');

const PORT = 8765;

// Replace this only if you create a different Discord Developer Portal application.
const DISCORD_CLIENT_ID = '157521380011287566';
const DISCORD_ASSET_KEY = 'sammyify_logo';

let rpc = null;
let rpcReady = false;
let pendingActivity = null;

function cleanText(value, max = 120) {
  return typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim().slice(0, max) : '';
}

async function connectDiscord() {
  try {
    DiscordRPC.register(DISCORD_CLIENT_ID);
    rpc = new DiscordRPC.Client({ transport: 'ipc' });

    rpc.on('ready', async () => {
      rpcReady = true;
      if (pendingActivity) await applyDiscordActivity(pendingActivity);
    });

    rpc.on('disconnected', () => {
      rpcReady = false;
    });

    await rpc.login({ clientId: DISCORD_CLIENT_ID });
  } catch (error) {
    // Discord may not be open. Sammyify should still work normally.
    console.warn('[Sammyify] Discord Rich Presence unavailable:', error.message);
    rpcReady = false;
  }
}

async function applyDiscordActivity(data) {
  if (!rpcReady || !rpc) return;

  try {
    if (!data || data.clear) {
      await rpc.clearActivity();
      return;
    }

    const title = cleanText(data.title, 120);
    const artist = cleanText(data.artist, 120) || 'Unknown artist';
    const album = cleanText(data.album, 120);
    if (!title) {
      await rpc.clearActivity();
      return;
    }

    const paused = Boolean(data.paused);
    const position = Number.isFinite(Number(data.position)) ? Math.max(0, Number(data.position)) : 0;
    const duration = Number.isFinite(Number(data.duration)) ? Math.max(0, Number(data.duration)) : 0;

    const activity = {
      type: 2, // Listening
      details: title,
      state: paused ? `Paused • ${artist}` : artist,
      largeImageKey: DISCORD_ASSET_KEY,
      largeImageText: album ? `${album} • Sammyify` : 'Sammyify',
      instance: false
    };

    // Discord calculates the elapsed/remaining display from these timestamps.
    // Omit them while paused so the timer does not continue moving.
    if (!paused) {
      activity.startTimestamp = Date.now() - position * 1000;
      if (duration > position) {
        activity.endTimestamp = Date.now() + (duration - position) * 1000;
      }
    }

    await rpc.setActivity(activity);
  } catch (error) {
    console.warn('[Sammyify] Could not update Discord activity:', error.message);
  }
}

ipcMain.on('sammyify:presence', (_event, data) => {
  pendingActivity = data && typeof data === 'object' ? data : { clear: true };
  applyDiscordActivity(pendingActivity);
});

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';

  const file = path.join(__dirname, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end();
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#080b10',
    title: 'Sammyify',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);
  win.loadURL(`http://127.0.0.1:${PORT}/index.html`);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`) && !url.startsWith('https://accounts.spotify.com')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

const lock = app.requestSingleInstanceLock();

if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(() => {
    connectDiscord();
    server.on('error', error => {
      console.error(error);
      createWindow();
    });
    server.listen(PORT, '127.0.0.1', createWindow);
  });

  app.on('before-quit', async () => {
    try {
      if (rpcReady && rpc) await rpc.clearActivity();
      if (rpc) await rpc.destroy();
    } catch {}
  });

  app.on('window-all-closed', () => {
    server.close();
    app.quit();
  });
}
