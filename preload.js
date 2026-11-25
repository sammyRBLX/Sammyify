const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sammyifyDiscord', {
  update: (activity) => ipcRenderer.send('sammyify:presence', activity),
  clear: () => ipcRenderer.send('sammyify:presence', { clear: true })
});
