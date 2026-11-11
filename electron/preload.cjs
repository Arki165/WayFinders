// Мост между окном (React) и главным процессом: только нужные функции
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  openOsm: () => ipcRenderer.invoke("open-osm"),
  saveText: (defaultName, text, filters) => ipcRenderer.invoke("save-text", { defaultName, text, filters }),
  savePng: (defaultName, base64) => ipcRenderer.invoke("save-png", { defaultName, base64 }),
  saveBinary: (defaultName, base64, filters) => ipcRenderer.invoke("save-binary", { defaultName, base64, filters }),
  savePdf: (defaultName, html) => ipcRenderer.invoke("save-pdf", { defaultName, html }),
  readExample: (name) => ipcRenderer.invoke("read-example", name),
  writeFile:(filePath, text) => ipcRenderer.invoke("write-file", { filePath, text }),
});
