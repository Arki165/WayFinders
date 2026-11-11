// Руководство пользователя. Открывается из меню в правом углу верхней панели.
// Слева список разделов, справа текст выбранного раздела. Тексты лежат в guide.ru.ts и guide.en.ts.
import { useState } from "react";
import { lang, tr } from "../i18n";
import { GUIDE_RU } from "../guide.ru";
import { GUIDE_EN } from "../guide.en";
import Icon from "./Icon";

export default function GuideDialog({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState(0);
  const guide = lang() === "en" ? GUIDE_EN : GUIDE_RU;
  const sec = guide[cur];
  // пункты «клавиша | действие» собираем в таблицу, остальные идут списком
  const rows = sec.items.filter((s) => s.includes(" | ")).map((s) => s.split(" | "));
  const before = sec.items.slice(0, sec.items.findIndex((s) => s.includes(" | ")) === -1 ? sec.items.length : sec.items.findIndex((s) => s.includes(" | ")));
  const after = sec.items.slice(before.length).filter((s) => !s.includes(" | "));
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog guide">
        <div className="guide-head">
          <h2>{tr("Руководство пользователя")}</h2>
          <button className="icon-btn" onClick={onClose} title={tr("Закрыть")}><Icon name="close" size={16} /></button>
        </div>
        <div className="guide-body">
          <nav className="guide-nav">
            {guide.map((s, i) => <button key={i} className={i === cur ? "on" : ""} onClick={() => setCur(i)}>{s.title}</button>)}
          </nav>
          <div className="guide-text">
            <h3>{sec.title}</h3>
            {before.length > 0 && <ul>{before.map((s, i) => <li key={i}>{s}</li>)}</ul>}
            {rows.length > 0 && <table><tbody>{rows.map((r, i) => <tr key={i}><td><b>{r[0]}</b></td><td>{r[1]}</td></tr>)}</tbody></table>}
            {after.length > 0 && <ul>{after.map((s, i) => <li key={i}>{s}</li>)}</ul>}
          </div>
        </div>
        <div className="foot">
          <button disabled={cur === 0} onClick={() => setCur(cur - 1)}><Icon name="chevronLeft" size={14} />{tr("Назад")}</button>
          <button disabled={cur === guide.length - 1} onClick={() => setCur(cur + 1)}>{tr("Дальше")}<Icon name="chevronRight" size={14} /></button>
        </div>
      </div>
    </div>
  );
}
