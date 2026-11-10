// Панель «Слои» на карте: уровень (город или метро) и что показывать
import { useState } from "react";
import { ICONS } from "./mapIcons";

export type Level = "city" | "metro";
export type LayerKey = "roads" | "lanes" | "signals" | "crossings" | "stops" | "metro" | "rail" | "paths" | "errors";
export type LayerShow = Record<LayerKey, boolean>;

export const DEFAULT_SHOW: LayerShow = { roads: true, lanes: true, signals: true, crossings: true, stops: true, metro: true, rail: true, paths: true, errors: true };

// Подписи и значок-образец для каждого слоя
const ROWS: { key: LayerKey; name: string; icon?: string; color?: string }[] = [
  { key: "roads", name: "Дороги", color: "#f0b445" },
  { key: "lanes", name: "Полосы и разметка", color: "#6b6f6a" },
  { key: "signals", name: "Светофоры", icon: ICONS.signal },
  { key: "crossings", name: "Пешеходные переходы", icon: ICONS.crossing },
  { key: "stops", name: "Остановки", icon: ICONS.bus },
  { key: "metro", name: "Метро", icon: ICONS.metro },
  { key: "rail", name: "Ж/д и трамвай", color: "#82649f" },
  { key: "paths", name: "Тротуары и дорожки", color: "#968273" },
  { key: "errors", name: "Ошибки графа", color: "#d8402f" },
];

// Сохраняем выбор только у себя на компьютере, чтобы он не сбрасывался при перезапуске
const KEY = "wayfinders-layers";
export function loadLayers(): { level: Level; show: LayerShow } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { level: v.level === "metro" ? "metro" : "city", show: { ...DEFAULT_SHOW, ...(v.show ?? {}) } };
  } catch {
    return { level: "city", show: { ...DEFAULT_SHOW } };
  }
}
export function saveLayers(level: Level, show: LayerShow) {
  try { localStorage.setItem(KEY, JSON.stringify({ level, show })); } catch { /* хранилище недоступно */ }
}

interface Props { level: Level; show: LayerShow; onLevel: (l: Level) => void; onShow: (s: LayerShow) => void; metroCount: number }

export default function LayersPanel({ level, show, onLevel, onShow, metroCount }: Props) {
  const [open, setOpen] = useState(false);
  const hidden = ROWS.filter((r) => !show[r.key]).length;
  return (
    <div className={"layers" + (open ? " open" : "")}>
      <button className="layers-head" onClick={() => setOpen(!open)} title="Уровни карты и слои: что показывать">
        ☰ Слои{level === "metro" ? ": метро" : ""}{hidden ? ` (скрыто ${hidden})` : ""} <span className="muted">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="layers-body">
          <div className="seg layers-level" title="Уровень карты">
            <button className={level === "city" ? "on" : ""} onClick={() => onLevel("city")}>Город</button>
            <button className={level === "metro" ? "on" : ""} onClick={() => onLevel("metro")}>Метро{metroCount ? "" : " (нет)"}</button>
          </div>
          {level === "metro" && <p className="hint">Метро ярко, город бледно. {metroCount ? `Линий метро: ${metroCount}.` : "В этом файле метро нет."}</p>}
          {ROWS.map((r) => (
            <label key={r.key} className="layers-row">
              <input type="checkbox" checked={show[r.key]} onChange={() => onShow({ ...show, [r.key]: !show[r.key] })} />
              {r.icon ? <img src={r.icon} alt="" /> : <i style={{ background: r.color }} />}
              {r.name}
            </label>
          ))}
          <div className="chips">
            <button onClick={() => onShow({ ...DEFAULT_SHOW })}>Показать все</button>
            <button onClick={() => onShow({ ...DEFAULT_SHOW, lanes: false, paths: false, rail: false, errors: false })} title="Только дороги и объекты для движения">Только дороги</button>
          </div>
        </div>
      )}
    </div>
  );
}
