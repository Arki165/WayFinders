// Мост между окном (React) и главным процессом: только нужные функции
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  openOsm: () => ipcRenderer.invoke("open-osm"),
  saveText: (defaultName, text, filters) => ipcRenderer.invoke("save-text", { defaultName, text, filters }),
  savePng: (defaultName, base64) => ipcRenderer.invoke("save-png", { defaultName, base64 }),
  readExample: () => ipcRenderer.invoke("read-example"),
  writeFile:(filePath, text) => ipcRenderer.invoke("write-file", { filePath, text }),
});
