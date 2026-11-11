// Главный процесс Electron: окно приложения и работа с файлами
const { app, BrowserWindow, ipcMain, dialog, screen, session } = require("electron");
const path = require("path");
const fs = require("fs");

// Программа переименована в Wayfinder, но настройки и свои шаблоны лежат в старой папке WayFinders.
// Оставляем старую папку, иначе после обновления шаблоны и тема пропадут.
app.setPath("userData", path.join(app.getPath("appData"), "WayFinders"));
// имя программы в меню и окнах «О программе», «Скрыть», «Выйти» (иначе в режиме разработки там «Electron»)
app.setName("Wayfinder");

// Windows: свой id приложения, тогда на панели задач окно с нашим значком, а не значком Electron
if (process.platform === "win32") app.setAppUserModelId("ru.wayfinders.editor");

// Наш значок: при разработке из public, в собранной программе из dist.
// Для дока macOS свой файл icon-mac.png: с прозрачными полями, как у других значков в доке
function iconPath(file = "icon.png") {
  const dev = path.join(__dirname, "..", "public", file);
  const built = path.join(__dirname, "..", "dist", file);
  return process.env.VITE_DEV || !fs.existsSync(built) ? dev : built;
}

// значок в доке macOS: в режиме разработки иначе виден значок Electron
function setDockIcon() {
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(iconPath("icon-mac.png"));
}

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
    icon: iconPath(), // значок окна и панели задач (Windows и Linux)
    backgroundColor: "#1a1f1c",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
    },
  });
  win.setMenuBarVisibility(false);

  // Закрытие окна с несохраненными правками: спрашиваем, чтобы работа не пропала от случайного крестика
  let closing = false;
  win.on("close", (e) => {
    if (closing) return;
    e.preventDefault();
    win.webContents.executeJavaScript("[!!(window.wfDirty && window.wfDirty()), document.documentElement.lang]")
      .catch(() => [false, "ru"]) // окно зависло или упало: закрываем без вопроса
      .then(([dirty, lang]) => {
        if (dirty) {
          const en = lang === "en";
          const choice = dialog.showMessageBoxSync(win, {
            type: "warning",
            title: "Wayfinder",
            message: en ? "There are unsaved edits" : "Есть несохраненные правки",
            detail: en ? "If you close the window, the edits will be lost." : "Если закрыть окно, правки пропадут.",
            buttons: en ? ["Close without saving", "Cancel"] : ["Закрыть без сохранения", "Отмена"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          if (choice !== 0) return;
        }
        closing = true;
        win.close();
      });
  });

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

// Сохранить двоичный файл (например, таблицу Excel), data приходит как base64
ipcMain.handle("save-binary", async (_e, { defaultName, base64, filters }) => {
  const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(base64, "base64"));
  return res.filePath;
});

// Сохранить PDF: страницу html открываем в скрытом окне и печатаем в PDF средствами Electron
ipcMain.handle("save-pdf", async (_e, { defaultName, html }) => {
  const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (res.canceled || !res.filePath) return null;
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: "A4", margins: { marginType: "default" } });
    fs.writeFileSync(res.filePath, pdf);
  } finally {
    win.destroy();
  }
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
  setDockIcon();
  createWindow();
});
app.on("window-all-closed", () => app.quit());
