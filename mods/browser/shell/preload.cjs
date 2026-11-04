// The toolbar page's only way to the shell: commands out, tab state and colors in.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("shell", {
  cmd: (name, ...args) => ipcRenderer.send("cmd", name, ...args),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, data) => fn(data)),
});
