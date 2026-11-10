// Меню в правом углу верхней панели: тема, язык, руководство пользователя и горячие клавиши.
// Собраны в одну кнопку, чтобы верхняя строка не переносилась на узком окне.
import { useEffect, useRef, useState } from "react";
import { LANGS, tr, useLang } from "../i18n";
import Icon from "./Icon";

interface Props {
  theme: string;
  setTheme: (t: "light" | "dark") => void;
  onGuide: () => void;
  onKeys: () => void;
}

export default function AppMenu({ theme, setTheme, onGuide, onKeys }: Props) {
  const [open, setOpen] = useState(false);
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const box = useRef<HTMLDivElement>(null);

  // клик мимо меню или Esc закрывает его
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div className="app-menu" ref={box}>
      <button className={"tb-icon" + (open ? " on" : "")} onClick={() => setOpen(!open)} title={tr("Настройки и руководство")}><Icon name="menu" /></button>
      {open && (
        <div className="app-menu-list">
          <div className="am-row">
            <span>{tr("Тема")}</span>
            <div className="seg">
              <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")}><Icon name="sun" size={14} />{tr("Светлая")}</button>
              <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")}><Icon name="moon" size={14} />{tr("Темная")}</button>
            </div>
          </div>
          <div className="am-row">
            <span>{tr("Язык")}</span>
            <div className="seg">
              {LANGS.map((l) => <button key={l.id} className={lang === l.id ? "on" : ""} onClick={() => setLang(l.id)}>{l.name}</button>)}
            </div>
          </div>
          <hr />
          <button className="am-item" onClick={() => { setOpen(false); onGuide(); }}><Icon name="book" size={16} />{tr("Руководство пользователя")}</button>
          <button className="am-item" onClick={() => { setOpen(false); onKeys(); }}><Icon name="keyboard" size={16} />{tr("Горячие клавиши")}<kbd>?</kbd></button>
        </div>
      )}
    </div>
  );
}
