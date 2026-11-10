import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { useEditor } from "./model/store";
import { VERSION } from "./version";

// номер версии в заголовке окна, чтобы его было видно на скриншотах и видео
document.title = `Wayfinder ${VERSION}`;

// в режиме разработки состояние доступно из консоли для проверки
if (import.meta.env.DEV) (window as unknown as { wf: typeof useEditor }).wf = useEditor;

createRoot(document.getElementById("root")!).render(<App />);
