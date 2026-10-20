// What the pages may ask of the app. The server's pages only report the theme; the local setup
// page can also find and pick servers and make this computer the server.
const { contextBridge, ipcRenderer } = require("electron");

const common = {
  themeChanged: (mode) => ipcRenderer.send("cellovision:theme", String(mode)),
  // This app's own "Update automatically" switch, shown in the menu.
  updates: () => ipcRenderer.invoke("cellovision:updates"),
  setAutoUpdate: (on) => ipcRenderer.invoke("cellovision:set-auto-update", !!on),
  checkUpdatesNow: () => ipcRenderer.invoke("cellovision:check-updates"),
  installUpdate: () => ipcRenderer.send("cellovision:install-update"),
};

if (location.protocol !== "file:") {
  contextBridge.exposeInMainWorld("CellovisionApp", common);
} else {
  contextBridge.exposeInMainWorld("CellovisionApp", {
    ...common,
    find: () => ipcRenderer.invoke("cellovision:find"),
    connect: (address) => ipcRenderer.invoke("cellovision:connect", address),
    state: () => ipcRenderer.invoke("cellovision:state"),
    beServer: (on) => ipcRenderer.invoke("cellovision:be-server", !!on),
    onServerState: (fn) => ipcRenderer.on("cellovision:server-state", (_e, s) => fn(s)),
  });
}
