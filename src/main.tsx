import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { useEditor } from "./model/store";
import { VERSION } from "./version";
import { writeOsm } from "./osm/write";

// номер версии в заголовке окна, чтобы его было видно на скриншотах и видео
document.title = `Wayfinder ${VERSION}`;

// в режиме разработки состояние и запись .osm доступны из консоли для проверки
if (import.meta.env.DEV) Object.assign(window, { wf: useEditor, wfWrite: writeOsm });

createRoot(document.getElementById("root")!).render(<App />);
