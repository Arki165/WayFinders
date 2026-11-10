// Панель «Слои» на карте: уровень (город или метро) и что показывать
import { useState } from "react";
import { ICONS } from "./mapIcons";
import Icon from "./Icon";
import { tr } from "../i18n";

export type Level = "city" | "metro";
export type LayerKey = "roads" | "lanes" | "signals" | "crossings" | "stops" | "metro" | "rail" | "paths" | "errors";
export type LayerShow = Record<LayerKey, boolean>;

export const DEFAULT_SHOW: LayerShow = { roads: true, lanes: true, signals: true, crossings: true, stops: true, metro: true, rail: true, paths: true, errors: true };

// Подписи и значок-образец для каждого слоя
const ROWS: { key: LayerKey; name: string; icon?: string; color?: string }[] = [
  { key: "roads", get name() { return tr("Дороги"); }, color: "#f0b445" },
  { key: "lanes", get name() { return tr("Полосы и разметка"); }, color: "#6b6f6a" },
  { key: "signals", get name() { return tr("Светофоры"); }, icon: ICONS.signal },
  { key: "crossings", get name() { return tr("Пешеходные переходы"); }, icon: ICONS.crossing },
  { key: "stops", get name() { return tr("Остановки"); }, icon: ICONS.bus },
  { key: "metro", get name() { return tr("Метро"); }, icon: ICONS.metro },
  { key: "rail", get name() { return tr("Ж/д и трамвай"); }, color: "#82649f" },
  { key: "paths", get name() { return tr("Тротуары и дорожки"); }, color: "#968273" },
  { key: "errors", get name() { return tr("Ошибки графа"); }, color: "#d8402f" },
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
      {/* только значок: и так понятно, что это слои. Число на значке - сколько слоев скрыто */}
      <button className={"layers-head" + (open ? " on" : "")} onClick={() => setOpen(!open)} title={tr("Уровни карты и слои: что показывать") + (level === "metro" ? tr(": метро") : "") + (hidden ? tr(" (скрыто {0})", hidden) : "")}>
        <Icon name="layers" size={16} />
        {hidden > 0 && <span className="layers-badge">{hidden}</span>}
      </button>
      {open && (
        <div className="layers-body">
          <div className="seg layers-level" title={tr("Уровень карты")}>
            <button className={level === "city" ? "on" : ""} onClick={() => onLevel("city")}>{tr("Город")}</button>
            <button className={level === "metro" ? "on" : ""} onClick={() => onLevel("metro")}>{tr("Метро")}{metroCount ? "" : tr(" (нет)")}</button>
          </div>
          {level === "metro" && <p className="hint">{tr("Метро ярко, город бледно.")}{" "}{metroCount ? tr("Линий метро: {0}.", metroCount) : tr("В этом файле метро нет.")}</p>}
          {ROWS.map((r) => (
            <label key={r.key} className="layers-row">
              <input type="checkbox" checked={show[r.key]} onChange={() => onShow({ ...show, [r.key]: !show[r.key] })} />
              {r.icon ? <img src={r.icon} alt="" /> : <i style={{ background: r.color }} />}
              {r.name}
            </label>
          ))}
          <div className="chips">
            <button onClick={() => onShow({ ...DEFAULT_SHOW })}>{tr("Показать все")}</button>
            <button onClick={() => onShow({ ...DEFAULT_SHOW, lanes: false, paths: false, rail: false, errors: false })} title={tr("Только дороги и объекты для движения")}>{tr("Только дороги")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
