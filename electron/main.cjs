// Главный процесс Electron: окно приложения и работа с файлами
const { app, BrowserWindow, ipcMain, dialog, screen, session } = require("electron");
const path = require("path");
const fs = require("fs");

// Программа переименована в Wayfinder, но настройки и свои шаблоны лежат в старой папке WayFinders.
// Оставляем старую папку, иначе после обновления шаблоны и тема пропадут.
app.setPath("userData", path.join(app.getPath("appData"), "WayFinders"));

function createWindow() {
  // окно не больше свободной части экрана (без панели задач),
  // иначе на ноутбуке с масштабом 125-150% часть окна уходит за край
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1440, area.width),
    height: Math.min(900, area.height),
    minWidth: Math.min(1000, area.width),
    minHeight: Math.min(600, area.height),
    center: true,
    title: "Wayfinder",
    icon: path.join(__dirname, "..", "dist", "icon.png"), // значок окна (на Windows и Linux)
    backgroundColor: "#1a1f1c",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
    },
  });
  win.setMenuBarVisibility(false);

  // WF_DEBUG=1: выводить ошибки окна в терминал (для поиска проблем)
  if (process.env.WF_DEBUG) {
    win.webContents.on("console-message", (e) => console.log("[окно]", e.level, e.message));
  }

  if (process.env.VITE_DEV) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// Открыть .osm: возвращает имя, путь и текст файла
ipcMain.handle("open-osm", async () => {
  const res = await dialog.showOpenDialog({
    title: "Открыть граф OSM",
    filters: [{ name: "OpenStreetMap", extensions: ["osm", "xml"] }],
    properties: ["openFile"],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  return { name: path.basename(filePath), path: filePath, text: fs.readFileSync(filePath, "utf8") };
});

// Сохранить текст (osm, csv) через окно "Сохранить как"
ipcMain.handle("save-text", async (_e, { defaultName, text, filters }) => {
  const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, text, "utf8");
  return res.filePath;
});

// Сохранить картинку (график в png), data приходит как base64
ipcMain.handle("save-png", async (_e, { defaultName, base64 }) => {
  const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: "PNG", extensions: ["png"] }] });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(base64, "base64"));
  return res.filePath;
});

// Встроенный пример example.osm (участок Иркутска от организаторов)
ipcMain.handle("read-example", async () => {
  const p = process.env.VITE_DEV ? path.join(__dirname, "..", "public", "example.osm") : path.join(__dirname, "..", "dist", "example.osm");
  return fs.readFileSync(p, "utf8");
});

// Перезаписать уже открытый файл
ipcMain.handle("write-file", async (_e, { filePath, text }) => {
  fs.writeFileSync(filePath, text, "utf8");
  return filePath;
});

// Overpass API отвечает 406 на запросы с подписью браузера (а Electron подписывается как Chrome).
// Для запросов к Overpass представляемся программой со ссылкой на проект, как просят правила сервера.
function setOverpassUserAgent() {
  const ua = `Wayfinder/${app.getVersion()} (+https://github.com/Arki165/WayFinders)`;
  const urls = ["https://overpass-api.de/*", "https://*.overpass-api.de/*"];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    details.requestHeaders["User-Agent"] = ua;
    callback({ requestHeaders: details.requestHeaders });
  });
}

app.whenReady().then(() => {
  setOverpassUserAgent();
  createWindow();
});
app.on("window-all-closed", () => app.quit());
