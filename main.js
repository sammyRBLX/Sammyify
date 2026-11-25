const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Serve the app from http://127.0.0.1:8765 (same address as serve.py) so that
// YouTube embeds and Spotify login work exactly like they do in a browser.
const PORT = 8765;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(__dirname, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 760, minHeight: 560,
    backgroundColor: '#080b10', title: 'Sammyify', autoHideMenuBar: true,
    webPreferences: { autoplayPolicy: 'no-user-gesture-required', contextIsolation: true }
  });
  Menu.setApplicationMenu(null);
  win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
  // Open outside links (Spotify dashboard etc.) in the normal browser, but keep the Spotify login redirect inside.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`) && !url.startsWith('https://accounts.spotify.com')) { e.preventDefault(); shell.openExternal(url); }
  });
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
  app.whenReady().then(() => {
    server.on('error', e => { console.error(e); createWindow(); });
    server.listen(PORT, '127.0.0.1', createWindow);
  });
  app.on('window-all-closed', () => { server.close(); app.quit(); });
}
