import { useState } from "react";
import { useEditor, reverseWay, deleteWay, deleteNode, setNodeTags, setWayTags } from "../model/store";
import { ROAD_CLASSES, SURFACES, SIGNAL_KEYS, drivableNodeSet, isSignalTagged, lanesOf, maxSpeed, wayName } from "../model/roads";
import { wayLengthM } from "../model/geo";
import { TEMPLATES, MODIFIERS } from "../model/templates";
import { calcWay } from "../model/calc";
import type { OsmNode, OsmWay, Tags } from "../osm/types";

const fmt = (x: number, n = 0) => x.toLocaleString("ru-RU", { minimumFractionDigits: n, maximumFractionDigits: n });

export default function PropsPanel() {
  const data = useEditor((s) => s.data);
  const sel = useEditor((s) => s.selection);
  useEditor((s) => s.version);
  if (!data) return null;
  if (sel?.kind === "way" && data.ways.has(sel.id)) return <WayPanel way={data.ways.get(sel.id)!} />;
  if (sel?.kind === "node" && data.nodes.has(sel.id)) return <NodePanel node={data.nodes.get(sel.id)!} />;
  return (
    <div className="pane">
      <h3>Ничего не выделено</h3>
      <p className="hint">Кликните по дороге или узлу на карте. Узлы видны при сильном приближении. Найти улицу можно поиском в верхней панели.</p>
    </div>
  );
}

function WayPanel({ way }: { way: OsmWay }) {
  const data = useEditor((s) => s.data)!;
  const norms = useEditor((s) => s.norms);
  const analysis = useEditor((s) => s.analysis);
  const setAnalysis = useEditor((s) => s.setAnalysis);
  const t = way.tags;
  const change = (patch: Tags, label: string, remove: string[] = []) => {
    const tags = { ...t, ...patch };
    for (const k of remove) delete tags[k];
    for (const k of Object.keys(tags)) if (tags[k] === "") delete tags[k];
    setWayTags(way.id, tags, label);
  };
  const L = wayLengthM(data, way);
  const c = calcWay(data, way, norms);
  const ow = t.oneway === "yes" || t.oneway === "1" ? "yes" : t.oneway === "-1" ? "-1" : "no";
  const level = t.bridge === "yes" ? "bridge" : t.tunnel === "yes" ? "tunnel" : "ground";
  const inAnalysis = analysis.includes(way.id);

  return (
    <div className="pane">
      <div>
        <input className="title-input" defaultValue={t.name ?? ""} key={way.id + (t.name ?? "")} placeholder={wayName(way)} onBlur={(e) => e.target.value !== (t.name ?? "") && change({ name: e.target.value }, "Название")} />
        <div className="sub">way {way.id}{way.id < 0 ? " (новая)" : ""} · {way.nodeIds.length} узлов · {fmt(L)} м</div>
      </div>

      <div className="form">
        <span>Класс</span>
        <select value={t.highway ?? ""} onChange={(e) => change({ highway: e.target.value }, "Класс дороги")}>
          {!ROAD_CLASSES[t.highway] && <option value={t.highway}>{t.highway}</option>}
          {Object.entries(ROAD_CLASSES).map(([k, v]) => <option key={k} value={k}>{v.ru}</option>)}
        </select>
        <span>Движение</span>
        <div className="seg">
          {([["no", "⇄ Двустороннее"], ["yes", "→ Туда"], ["-1", "← Обратно"]] as const).map(([v, l]) => (
            <button key={v} className={ow === v ? "on" : ""} onClick={() => change({ oneway: v }, "Направление")}>{l}</button>
          ))}
        </div>
        <span>Полосы</span>
        <div className="step">
          <button onClick={() => change({ lanes: String(Math.max(1, lanesOf(way) - 1)) }, "Полосы", ["lanes:forward", "lanes:backward"])}>−</button>
          <b>{lanesOf(way)}</b>
          <button onClick={() => change({ lanes: String(Math.min(8, lanesOf(way) + 1)) }, "Полосы", ["lanes:forward", "lanes:backward"])}>+</button>
          {!t.lanes && <span className="tag-warn">не задано</span>}
        </div>
        <span>Скорость</span>
        <select value={t.maxspeed ?? ""} onChange={(e) => change({ maxspeed: e.target.value }, "Скорость")}>
          <option value="">не задана ({maxSpeed(way)})</option>
          {["20", "30", "40", "50", "60", "70", "80", "90", "RU:urban"].map((v) => <option key={v} value={v}>{v === "RU:urban" ? "городская (60)" : v + " км/ч"}</option>)}
          {t.maxspeed && !["20", "30", "40", "50", "60", "70", "80", "90", "RU:urban"].includes(t.maxspeed) && <option value={t.maxspeed}>{t.maxspeed}</option>}
        </select>
        <span>Покрытие</span>
        <select value={t.surface ?? ""} onChange={(e) => change({ surface: e.target.value }, "Покрытие")}>
          <option value="">не задано</option>
          {Object.entries(SURFACES).map(([k, v]) => <option key={k} value={k}>{v.ru} (×{norms.surfaceK[k] ?? v.k})</option>)}
          {t.surface && !SURFACES[t.surface] && <option value={t.surface}>{t.surface}</option>}
        </select>
        <span>Уровень</span>
        <div className="seg">
          {(["tunnel", "ground", "bridge"] as const).map((v) => (
            <button key={v} className={level === v ? "on" : ""} onClick={() => change(MODIFIERS[v].tags, MODIFIERS[v].name, MODIFIERS[v].remove)}>{v === "tunnel" ? "Тоннель" : v === "bridge" ? "Мост" : "Земля"}</button>
          ))}
        </div>
      </div>

      <div className="mini-calc">
        <div><small>V своб</small><b>{fmt(c.Vfree)} км/ч</b><small>{c.kSurface !== 1 ? `${fmt(c.Vmax)} × ${c.kSurface}` : "по maxspeed"}</small></div>
        <div><small>T своб</small><b>{fmt(c.Tfree, 2)} мин</b><small>L / V своб</small></div>
        <div><small>P</small><b>{fmt(c.P)}</b><small>авт/ч</small></div>
      </div>

      <h3>Шаблоны</h3>
      <div className="chips">
        {Object.entries(TEMPLATES).map(([k, v]) => <button key={k} onClick={() => change(v.tags, "Шаблон: " + v.name, ["lanes:forward", "lanes:backward"])}>{v.name}</button>)}
        <button onClick={() => change(MODIFIERS.roundabout.tags, "Кольцо")}>Кольцо</button>
      </div>

      <TagEditor tags={t} onChange={(tags, label) => setWayTags(way.id, tags, label)} />

      <div className="chips">
        <button onClick={() => reverseWay(way.id)}>Развернуть (R)</button>
        <button className={inAnalysis ? "on" : ""} onClick={() => setAnalysis(inAnalysis ? analysis.filter((x) => x !== way.id) : [...analysis, way.id])}>{inAnalysis ? "Убрать из расчета" : "Добавить в расчет"}</button>
        <button className="danger" onClick={() => deleteWay(way.id)}>Удалить дорогу</button>
      </div>
    </div>
  );
}

function NodePanel({ node }: { node: OsmNode }) {
  const data = useEditor((s) => s.data)!;
  const select = useEditor((s) => s.select);
  const t = node.tags;
  const onRoad = drivableNodeSet(data).has(node.id);
  const ways = [...data.ways.values()].filter((w) => w.nodeIds.includes(node.id) && w.tags.highway);
  const isSignal = isSignalTagged(node);
  const change = (patch: Tags, label: string, remove: string[] = []) => {
    const tags = { ...t, ...patch };
    for (const k of remove) delete tags[k];
    for (const k of Object.keys(tags)) if (tags[k] === "") delete tags[k];
    setNodeTags(node.id, tags, label);
  };
  const num = (k: string) => (t[k] ? Number(t[k]) : 0);
  const cycle = num(SIGNAL_KEYS.cycle), green = num(SIGNAL_KEYS.green), yellow = num(SIGNAL_KEYS.yellow), red = num(SIGNAL_KEYS.red);
  const sum = green + yellow + red;

  return (
    <div className="pane">
      <div>
        <div className="title-input">{ways.length >= 3 ? `Перекресток, ${ways.length} дорог` : ways.length === 2 ? "Стык двух дорог" : ways.length === 1 ? "Узел дороги" : "Отдельная точка"}</div>
        <div className="sub">node {node.id} · {node.lat.toFixed(6)}, {node.lon.toFixed(6)}</div>
      </div>

      <div className="switch">
        <span>Светофор</span>
        <button className={isSignal ? "on" : ""} disabled={!onRoad && !isSignal} onClick={() => (isSignal ? change(t.crossing === "traffic_signals" ? { crossing: "uncontrolled" } : {}, "Светофор убран", [...(t.highway === "traffic_signals" ? ["highway"] : []), ...Object.values(SIGNAL_KEYS)]) : change({ highway: "traffic_signals" }, "Светофор добавлен"))}>{isSignal ? "Есть" : "Нет"}</button>
      </div>
      {!onRoad && <p className="hint">Узел не лежит на проезжей дороге: светофор здесь не учитывается (например, железнодорожный сигнал).</p>}

      {isSignal && onRoad && (
        <div className="signal-box">
          <h3>Время работы светофора</h3>
          <div className="form">
            {([["cycle", "Цикл, с"], ["green", "Зеленый, с"], ["yellow", "Желтый, с"], ["red", "Красный, с"]] as const).map(([k, l]) => (
              <SignalField key={k} label={l} value={t[SIGNAL_KEYS[k]] ?? ""} onSave={(v) => change({ [SIGNAL_KEYS[k]]: v }, "Время светофора")} />
            ))}
          </div>
          {sum > 0 && (
            <div className="phase-bar" title="Фазы светофора">
              <i style={{ flex: green, background: "#3fb265" }} />
              <i style={{ flex: yellow, background: "#e8b931" }} />
              <i style={{ flex: red, background: "#e5483f" }} />
            </div>
          )}
          {cycle > 0 && sum > 0 && sum !== cycle && <p className="hint warn">Сумма фаз {sum} с не равна циклу {cycle} с.</p>}
          {sum > 0 && <p className="hint">Доля зеленого: {Math.round((green / sum) * 100)}%. Время хранится в тегах wayfinders:* и сохраняется в .osm.</p>}
          <div className="chips">
            <button onClick={() => change({ [SIGNAL_KEYS.cycle]: "60", [SIGNAL_KEYS.green]: "27", [SIGNAL_KEYS.yellow]: "3", [SIGNAL_KEYS.red]: "30" }, "Время светофора: 60 с")}>Цикл 60 с</button>
            <button onClick={() => change({ [SIGNAL_KEYS.cycle]: "90", [SIGNAL_KEYS.green]: "42", [SIGNAL_KEYS.yellow]: "3", [SIGNAL_KEYS.red]: "45" }, "Время светофора: 90 с")}>Цикл 90 с</button>
          </div>
        </div>
      )}

      <div className="switch">
        <span>Пешеходный переход</span>
        <button className={t.highway === "crossing" || t.crossing ? "on" : ""} disabled={isSignal} onClick={() => (t.highway === "crossing" ? change({}, "Переход убран", ["highway", "crossing"]) : change({ highway: "crossing", crossing: "uncontrolled" }, "Переход добавлен"))}>{t.highway === "crossing" ? "Есть" : "Нет"}</button>
      </div>

      <h3>Дороги через узел</h3>
      <div className="chips">{ways.map((w) => <button key={w.id} onClick={() => select({ kind: "way", id: w.id })}>{wayName(w)}</button>)}</div>

      <TagEditor tags={t} onChange={(tags, label) => setNodeTags(node.id, tags, label)} />
      <div className="chips"><button className="danger" onClick={() => deleteNode(node.id)}>Удалить узел</button></div>
    </div>
  );
}

function SignalField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  return (
    <>
      <span>{label}</span>
      <input type="number" min="0" step="1" defaultValue={value} key={value} onBlur={(e) => e.target.value !== value && onSave(e.target.value)} />
    </>
  );
}

function TagEditor({ tags, onChange }: { tags: Tags; onChange: (t: Tags, label: string) => void }) {
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  return (
    <div>
      <h3>Теги OSM</h3>
      <table className="tags">
        <tbody>
          {Object.entries(tags).map(([key, val]) => (
            <tr key={key + val}>
              <td>{key}</td>
              <td><input defaultValue={val} onBlur={(e) => e.target.value !== val && onChange({ ...tags, [key]: e.target.value }, "Тег " + key)} /></td>
              <td><button className="x" title="Удалить тег" onClick={() => { const n = { ...tags }; delete n[key]; onChange(n, "Удален тег " + key); }}>×</button></td>
            </tr>
          ))}
          <tr>
            <td><input placeholder="ключ" value={k} onChange={(e) => setK(e.target.value)} /></td>
            <td><input placeholder="значение" value={v} onChange={(e) => setV(e.target.value)} /></td>
            <td><button className="x" title="Добавить тег" onClick={() => { if (!k.trim()) return; onChange({ ...tags, [k.trim()]: v }, "Тег " + k.trim()); setK(""); setV(""); }}>+</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
