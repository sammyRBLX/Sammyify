const { contextBridge, ipcRenderer } = require('electron');

// Exposes a tiny, safe bridge to the page (index.html)
contextBridge.exposeInMainWorld('sammify', {
  presence: (data) => ipcRenderer.send('presence', data),
});
