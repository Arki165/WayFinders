import { useState, type ReactNode } from "react";
import "./props.css";
import {
  useEditor, reverseWay, deleteWay, deleteWays, deleteNode, setNodeTags, setWayTags, unjoinNode, patchSelection,
  makeRoundabout, makeUturn, makeTurn, insertBridge, setCrossing, removeCrossing, flipCrossing, crossingOf,
  embeddedTram, setTramOnRoad, templateFromWays, insertTemplate,
} from "../model/store";
import {
  ROAD_CLASSES, CITY_CLASSES, CLASS_HINT, ROAD_CATEGORIES, CATEGORY_KEY, SURFACES, SIGNAL_KEYS, TRACKS,
  isDrivable, isSignalTagged, isTrack, lanesOf, maxSpeed, nodeArms, phaseKey, sideRu, sideOf, azimuth, surfaceName, wayName, type Arm,
} from "../model/roads";
import { wayLengthM } from "../model/geo";
import { TEMPLATES, MODIFIERS, loadCustom, saveCustom, type CustomTemplate } from "../model/templates";
import { calcWay } from "../model/calc";
import { getMapBounds } from "./MapView";
import type { OsmNode, OsmWay, Tags } from "../osm/types";
import Icon from "./Icon";

const fmt = (x: number, n = 0) => x.toLocaleString("ru-RU", { minimumFractionDigits: n, maximumFractionDigits: n });
const SPEEDS = ["20", "30", "40", "50", "60", "70", "80", "90", "110", "RU:urban"];
const speedText = (v: string) => (v === "RU:urban" ? "Городская (60)" : v + " км/ч");
// значение тега у всех дорог: одинаковое или null, если разные
const common = (ws: OsmWay[], f: (w: OsmWay) => string) => (ws.every((w) => f(w) === f(ws[0])) ? f(ws[0]) : null);

// чистка тегов: пустые значения и ключи из remove удаляются
function patched(tags: Tags, patch: Tags, remove: string[] = []): Tags {
  const t = { ...tags, ...patch };
  for (const k of remove) delete t[k];
  for (const k of Object.keys(t)) if (t[k] === "") delete t[k];
  return t;
}

export default function PropsPanel() {
  const data = useEditor((s) => s.data);
  const sel = useEditor((s) => s.selection);
  useEditor((s) => s.version);
  if (!data) return null;
  if (sel?.kind === "way" && data.ways.has(sel.id)) {
    const w = data.ways.get(sel.id)!;
    return isDrivable(w) ? <WayPanel way={w} /> : <OtherPanel way={w} />;
  }
  if (sel?.kind === "ways") return <WaysPanel ids={sel.ids.filter((id) => data.ways.has(id))} />;
  if (sel?.kind === "node" && data.nodes.has(sel.id)) return <NodePanel node={data.nodes.get(sel.id)!} />;
  return <LibraryPanel />;
}

// ---------- общие поля дороги: для одной дороги и для нескольких сразу ----------
// get - значение у выделенного (null - разное), set - применить изменения
interface Fields {
  get: (f: (w: OsmWay) => string) => string | null;
  set: (patch: Tags, label: string, remove?: string[]) => void;
}

function RoadFields({ get, set }: Fields) {
  const norms = useEditor((s) => s.norms);
  const ow = get((w) => (w.tags.oneway === "yes" || w.tags.oneway === "1" || (w.tags.junction === "roundabout" && w.tags.oneway !== "-1") ? "yes" : w.tags.oneway === "-1" ? "-1" : "no"));
  const lanes = get((w) => String(lanesOf(w)));
  const level = get((w) => (w.tags.bridge === "yes" ? "bridge" : w.tags.tunnel === "yes" ? "tunnel" : "ground"));
  const speed = get((w) => w.tags.maxspeed ?? "");
  const surface = get((w) => w.tags.surface ?? "");
  const defSpeed = get((w) => String(maxSpeed(w)));
  const bus = get((w) => (w.tags.busway === "lane" ? "both" : w.tags["busway:right"] === "lane" ? "right" : "no"));
  const n = lanes === null ? null : Number(lanes);

  return (
    <div className="form">
      <span>Класс</span>
      <ClassPicker get={get} set={set} />
      <span>Движение</span>
      <div className="seg">
        {([["no", "twoWay", "Обе", "Движение в обе стороны"], ["yes", "arrowRight", "Туда", "Одностороннее по направлению линии"], ["-1", "arrowLeft", "Обратно", "Одностороннее против направления линии"]] as const).map(([v, ic, l, t]) => (
          <button key={v} className={ow === v ? "on" : ""} title={t} onClick={() => set({ oneway: v }, "Направление")}><Icon name={ic} size={15} />{l}</button>
        ))}
      </div>
      <span>Полосы</span>
      <div className="step">
        <button disabled={n === null} onClick={() => set({ lanes: String(Math.max(1, n! - 1)) }, "Полосы", ["lanes:forward", "lanes:backward"])} title="Меньше полос"><Icon name="minus" size={14} /></button>
        <b>{n ?? "разные"}</b>
        <button disabled={n === null} onClick={() => set({ lanes: String(Math.min(8, n! + 1)) }, "Полосы", ["lanes:forward", "lanes:backward"])} title="Больше полос"><Icon name="plus" size={14} /></button>
        {n === null && <select value="" onChange={(e) => set({ lanes: e.target.value }, "Полосы", ["lanes:forward", "lanes:backward"])}><option value="">Задать всем</option>{[1, 2, 3, 4, 5, 6].map((k) => <option key={k} value={k}>{k}</option>)}</select>}
        {get((w) => w.tags.lanes ?? "") === "" && <span className="tag-warn">не задано</span>}
      </div>
      <span>Скорость</span>
      <select value={speed ?? "*"} onChange={(e) => set({ maxspeed: e.target.value }, "Скорость")}>
        {speed === null && <option value="*">Разная</option>}
        <option value="">Не задана{defSpeed ? ` (${defSpeed})` : ""}</option>
        {SPEEDS.map((v) => <option key={v} value={v}>{speedText(v)}</option>)}
        {speed && !SPEEDS.includes(speed) && <option value={speed}>{speed}</option>}
      </select>
      <span>Покрытие</span>
      <select value={surface ?? "*"} onChange={(e) => set({ surface: e.target.value }, "Покрытие")}>
        {surface === null && <option value="*">Разное</option>}
        <option value="">Не задано</option>
        {Object.entries(SURFACES).map(([k, v]) => <option key={k} value={k}>{v.ru} (×{norms.surfaceK[k] ?? v.k})</option>)}
        {surface && !SURFACES[surface] && <option value={surface}>{surfaceName(surface)} (из файла)</option>}
      </select>
      <span title="Мост или тоннель">Искусственные сооружения</span>
      <div className="seg">
        {(["ground", "bridge", "tunnel"] as const).map((v) => (
          <button key={v} className={level === v ? "on" : ""} onClick={() => set(MODIFIERS[v].tags, MODIFIERS[v].name, MODIFIERS[v].remove)}>{v === "tunnel" ? "Тоннель" : v === "bridge" ? "Мост" : "Нет"}</button>
        ))}
      </div>
      <span title="Выделенная полоса для автобусов">Автобусная полоса</span>
      <div className="seg">
        {([["no", "Нет"], ["right", "Справа"], ["both", "С двух сторон"]] as const).map(([v, l]) => (
          <button key={v} className={bus === v ? "on" : ""} onClick={() => set(v === "no" ? {} : v === "right" ? { "busway:right": "lane", "lanes:bus": "1" } : { busway: "lane", "lanes:bus": "2" }, v === "no" ? "Автобусная полоса убрана" : "Автобусная полоса", v === "no" ? ["busway", "busway:right", "lanes:bus"] : v === "right" ? ["busway"] : ["busway:right"])}>{l}</button>
        ))}
      </div>
    </div>
  );
}

// Выбор класса: текущий класс кнопкой, по клику меню из двух групп
function ClassPicker({ get, set }: Fields) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<"city" | "public">("city");
  const hw = get((w) => w.tags.highway ?? "");
  const cat = get((w) => w.tags[CATEGORY_KEY] ?? "");
  const catInfo = ROAD_CATEGORIES.find((c) => c.id === cat);
  const label = hw === null ? "Разные классы" : catInfo ? catInfo.ru : ROAD_CLASSES[hw]?.ru ?? hw;
  const color = hw && ROAD_CLASSES[hw] ? ROAD_CLASSES[hw].color : [200, 200, 200];
  const pick = (patch: Tags, name: string, remove: string[] = []) => { set(patch, "Класс дороги: " + name, remove); setOpen(false); };
  const lanesSet = get((w) => (w.tags.lanes ? "y" : "")) === "y", speedSet = get((w) => (w.tags.maxspeed ? "y" : "")) === "y";

  return (
    <div className="cls">
      <button className="cls-cur" onClick={() => setOpen(!open)} title="Выбрать класс дороги">
        <i className="cls-sw" style={{ background: `rgb(${color.join(",")})` }} />
        <span>{label}</span>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} className="muted" />
      </button>
      {open && (
        <div className="cls-menu">
          <div className="seg cls-tabs">
            <button className={group === "city" ? "on" : ""} onClick={() => setGroup("city")}>Улицы города</button>
            <button className={group === "public" ? "on" : ""} onClick={() => setGroup("public")}>Общего пользования</button>
          </div>
          {group === "city" && CITY_CLASSES.map((k) => (
            <button key={k} className={"cls-item" + (hw === k && !catInfo ? " on" : "")} onClick={() => pick({ highway: k }, ROAD_CLASSES[k].ru, [CATEGORY_KEY])}>
              <i className="cls-sw" style={{ background: `rgb(${ROAD_CLASSES[k].color.join(",")})` }} />
              <span><b>{ROAD_CLASSES[k].ru}</b><small>{CLASS_HINT[k]}</small></span>
            </button>
          ))}
          {group === "public" && (
            <>
              <table className="cat-tbl">
                <thead><tr><th>Класс дороги</th><th>Категория</th><th>Интенсивность, прив. ед./сут</th></tr></thead>
                <tbody>
                  {ROAD_CATEGORIES.map((c, i) => {
                    // класс пишем один раз на группу строк, как в таблице ГОСТ
                    const first = i === 0 || ROAD_CATEGORIES[i - 1].cls !== c.cls;
                    const span = ROAD_CATEGORIES.filter((x) => x.cls === c.cls).length;
                    const choose = () => pick({ highway: c.highway, [CATEGORY_KEY]: c.id, ...(lanesSet ? {} : { lanes: String(c.lanes) }), ...(speedSet ? {} : { maxspeed: String(c.speed) }) }, c.ru);
                    return (
                      <tr key={c.id} className={cat === c.id ? "on" : ""}>
                        {first && <td rowSpan={span} className="cat-cls">{c.cls}</td>}
                        <td className="cat-pick" onClick={choose} title={`Выбрать: ${c.ru}`}>
                          <i className="cls-sw" style={{ background: `rgb(${ROAD_CLASSES[c.highway].color.join(",")})` }} />
                          <b>{c.cat}</b>
                        </td>
                        <td className="cat-pick" onClick={choose}>{c.flow}<small>{c.lanes} пол., {c.speed} км/ч</small></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="hint">Дорога IВ имеет те же геометрические характеристики, что и IБ, но допускает пересечения в одном уровне со светофорами. Кликните категорию: если полосы и скорость не заданы, ставятся типовые.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- одна дорога ----------
function WayPanel({ way }: { way: OsmWay }) {
  const data = useEditor((s) => s.data)!;
  const norms = useEditor((s) => s.norms);
  const analysis = useEditor((s) => s.analysis);
  const setAnalysis = useEditor((s) => s.setAnalysis);
  const t = way.tags;
  const change = (patch: Tags, label: string, remove: string[] = []) => setWayTags(way.id, patched(t, patch, remove), label);
  const L = wayLengthM(data, way);
  const c = calcWay(data, way, norms);
  const inAnalysis = analysis.includes(way.id);
  const tram = embeddedTram(data, way).length > 0;

  return (
    <div className="pane">
      <div>
        <Head actions={<>
          <button className="icon-btn" onClick={() => reverseWay(way.id)} title="Развернуть направление (R)"><Icon name="reverse" size={16} /></button>
          <button className="icon-btn danger" onClick={() => deleteWay(way.id)} title="Удалить дорогу (Delete)"><Icon name="trash" size={16} /></button>
        </>}>
          <input className="title-input" defaultValue={t.name ?? ""} key={way.id + (t.name ?? "")} placeholder={wayName(way)} title="Название улицы, можно изменить" onBlur={(e) => e.target.value !== (t.name ?? "") && change({ name: e.target.value }, "Название")} />
        </Head>
        <div className="sub">Дорога {way.id}{way.id < 0 ? " (новая)" : ""} · {way.nodeIds.length} узлов · {fmt(L)} м</div>
      </div>

      <RoadFields get={(f) => f(way)} set={change} />
      <div className="switch">
        <span title="Трамвайные пути по проезжей части. Концы сами стыкуются с путями рядом (до 15 м)">Трамвай по дороге</span>
        <button className={tram ? "on" : ""} onClick={() => setTramOnRoad(way.id, !tram)}>{tram ? "Есть" : "Нет"}</button>
      </div>

      <div className="mini-calc">
        <div><small>V своб</small><b>{fmt(c.Vfree)} км/ч</b><small>{c.kSurface !== 1 ? `${fmt(c.Vmax)} × ${c.kSurface}` : "по знаку"}</small></div>
        <div><small>T своб</small><b>{fmt(c.Tfree, 2)} мин</b><small>L / V своб</small></div>
        <div><small>P</small><b>{fmt(c.P)}</b><small>авт/ч</small></div>
      </div>

      <h3>Шаблоны</h3>
      <div className="chips">
        {Object.entries(TEMPLATES).filter(([, v]) => !v.kind).map(([k, v]) => <button key={k} onClick={() => change(v.tags, "Шаблон: " + v.name, ["lanes:forward", "lanes:backward", CATEGORY_KEY])}>{v.name}</button>)}
      </div>
      <div className="chips">
        <button onClick={() => insertBridge(way.id)} title="Участок дороги 50 м над пересечением с другой дорогой (или в середине) становится мостом"><Icon name="bridge" size={15} />Вставить мост</button>
        <SaveTemplate ids={[way.id]} />
      </div>
      <p className="hint">Shift+клик по другим дорогам выделяет несколько сразу. Shift+клик по двум узлам выделяет участок между ними.</p>

      <div className="chips">
        <button className={inAnalysis ? "on" : ""} onClick={() => setAnalysis(inAnalysis ? analysis.filter((x) => x !== way.id) : [...analysis, way.id])}>{inAnalysis ? "Убрать из расчета" : "Добавить в расчет"}</button>
      </div>
    </div>
  );
}

// Шапка панели: название выделенного и быстрые действия справа (как в больших редакторах)
function Head({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="panel-head">
      <div className="panel-title">{children}</div>
      {actions && <div className="panel-actions">{actions}</div>}
    </div>
  );
}

// ---------- несколько дорог или участок ----------
function WaysPanel({ ids }: { ids: number[] }) {
  const data = useEditor((s) => s.data)!;
  const sel = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const ws = ids.map((id) => data.ways.get(id)!).filter(Boolean);
  const roads = ws.filter(isDrivable);
  const section = sel?.kind === "ways" ? sel.section : undefined;
  if (!ws.length) return null;
  const L = section ? section.length : ws.reduce((s, w) => s + wayLengthM(data, w), 0);

  return (
    <div className="pane">
      <div>
        <div className="title-input">{section ? "Участок между узлами" : `Выделено дорог: ${ws.length}`}</div>
        <div className="sub">{section ? `через ${ws.length} ${ws.length === 1 ? "дорогу" : "дорог"} · ` : ""}{fmt(L)} м</div>
      </div>
      {section && <p className="hint">Изменения применятся только к участку: дороги на его краях разрежутся сами.</p>}
      {roads.length > 0 && <RoadFields get={(f) => common(roads, f)} set={(patch, label, remove = []) => patchSelection(patch, remove, label)} />}
      {roads.length < ws.length && <p className="hint">Кроме дорог выделены пути или дорожки: {ws.length - roads.length}. Их параметры здесь не меняются.</p>}
      <div className="chips">{ws.slice(0, 12).map((w) => <button key={w.id} onClick={() => select({ kind: "way", id: w.id })}>{wayName(w)}</button>)}{ws.length > 12 && <span className="hint">и еще {ws.length - 12}</span>}</div>
      <div className="chips">
        {!section && <SaveTemplate ids={ids} />}
        <button onClick={() => select(null)}>Снять выделение</button>
        {!section && <button className="danger" onClick={() => deleteWays(ids)}>Удалить все ({ids.length})</button>}
      </div>
    </div>
  );
}

// ---------- рельсы, переходы, дорожки ----------
function OtherPanel({ way }: { way: OsmWay }) {
  const data = useEditor((s) => s.data)!;
  const t = way.tags;
  const change = (patch: Tags, label: string, remove: string[] = []) => setWayTags(way.id, patched(t, patch, remove), label);
  const building = !!t.building;
  const kind = building ? "Здание" : isTrack(way) ? TRACKS[t.railway] : t.footway === "crossing" ? "Пешеходный переход" : t.highway ? "Пешеходная или служебная дорожка" : "Линия";
  return (
    <div className="pane">
      <div>
        <Head actions={<>
          {!building && <button className="icon-btn" onClick={() => reverseWay(way.id)} title="Развернуть направление (R)"><Icon name="reverse" size={16} /></button>}
          <button className="icon-btn danger" onClick={() => deleteWay(way.id)} title={(building ? "Удалить здание" : "Удалить") + " (Delete)"}><Icon name="trash" size={16} /></button>
        </>}>
          <input className="title-input" defaultValue={t.name ?? ""} key={way.id + (t.name ?? "")} placeholder={kind} title="Название, можно изменить" onBlur={(e) => e.target.value !== (t.name ?? "") && change({ name: e.target.value }, "Название")} />
        </Head>
        <div className="sub">{kind} · {way.nodeIds.length} узлов · {building ? `площадь ${fmt(areaM2(data, way))} м²` : `${fmt(wayLengthM(data, way))} м`}</div>
      </div>
      {building && (
        <div className="form">
          <NumField label="Этажей" value={t["building:levels"] ?? ""} onSave={(v) => change({ "building:levels": v }, "Этажность здания")} />
          <span>Высота</span>
          <span>около {fmt((parseFloat(t["building:levels"] ?? "") || 3) * 3)} м (3 м на этаж), так здание видно в 3D</span>
        </div>
      )}
      {building && <p className="hint">Новое здание: инструмент «Нарисовать» (W), шаблон «Здание», кликайте углы, Enter - готово. Удалить: корзина вверху панели, Delete или инструмент D.</p>}
      {isTrack(way) && (
        <div className="form">
          <span>Вид</span>
          <div className="seg">
            {(["tram", "rail"] as const).map((k) => <button key={k} className={t.railway === k ? "on" : ""} onClick={() => change({ railway: k }, "Вид путей")} title={TRACKS[k]}>{k === "tram" ? "Трамвай" : "Ж/д"}</button>)}
          </div>
          {t.embedded === "yes" && <><span>Где</span><span>По проезжей части дороги</span></>}
        </div>
      )}
      {isTrack(way) && <p className="hint">Рельсы рисуются инструментом «Нарисовать дорогу» (W) с шаблоном путей. Концы ближе 15 м к другим путям стыкуются сами, на пересечении с дорогой ставится переезд.</p>}
      <div className="chips">
        <SaveTemplate ids={[way.id]} />
      </div>
    </div>
  );
}

// Площадь замкнутого контура в квадратных метрах (формула площади многоугольника)
function areaM2(data: { nodes: Map<number, OsmNode> }, w: OsmWay): number {
  const pts = w.nodeIds.map((id) => data.nodes.get(id)).filter(Boolean) as OsmNode[];
  if (pts.length < 3) return 0;
  const kx = 111320 * Math.cos((pts[0].lat * Math.PI) / 180), ky = 110540;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += (a.lon * kx) * (b.lat * ky) - (b.lon * kx) * (a.lat * ky);
  }
  return Math.abs(s) / 2;
}

// ---------- узел ----------
const SIDE_NOM: Record<string, string> = { N: "Север", NE: "Северо-восток", E: "Восток", SE: "Юго-восток", S: "Юг", SW: "Юго-запад", W: "Запад", NW: "Северо-запад" };
const SIDE_ADJ: Record<string, string> = { N: "северной", NE: "северо-восточной", E: "восточной", SE: "юго-восточной", S: "южной", SW: "юго-западной", W: "западной", NW: "северо-западной" };

function NodePanel({ node }: { node: OsmNode }) {
  const data = useEditor((s) => s.data)!;
  const select = useEditor((s) => s.select);
  const setTool = useEditor((s) => s.setTool);
  const t = node.tags;
  const ways = [...data.ways.values()].filter((w) => w.nodeIds.includes(node.id) && w.tags.highway);
  const roads = ways.filter(isDrivable);
  const onRoad = roads.length > 0;
  const isSignal = isSignalTagged(node);
  const arms = onRoad ? nodeArms(data, node.id) : [];
  const change = (patch: Tags, label: string, remove: string[] = []) => setNodeTags(node.id, patched(t, patch, remove), label);
  const isEnd = roads.length === 1 && (roads[0].nodeIds[0] === node.id || roads[0].nodeIds[roads[0].nodeIds.length - 1] === node.id);

  return (
    <div className="pane">
      <div>
        <Head actions={<button className="icon-btn danger" onClick={() => deleteNode(node.id)} title="Удалить узел (Delete)"><Icon name="trash" size={16} /></button>}>
          <div className="title-input">{roads.length >= 3 ? `Перекресток, ${roads.length} дорог` : roads.length === 2 ? "Стык двух дорог" : roads.length === 1 ? (isEnd ? "Конец дороги" : "Узел дороги") : "Отдельная точка"}</div>
        </Head>
        <div className="sub">Узел {node.id} · {node.lat.toFixed(6)}, {node.lon.toFixed(6)}</div>
      </div>

      <div className="switch">
        <span>Светофор</span>
        <button className={isSignal ? "on" : ""} disabled={!onRoad && !isSignal} onClick={() => {
          // переход в этом узле остается: без светофора нерегулируемый, со светофором регулируемый
          const cross = t.highway === "crossing" || !!t.crossing;
          const phases = Object.keys(t).filter((k) => k.startsWith("wayfinders:") && k !== "wayfinders:category");
          if (isSignal) change(cross ? { highway: "crossing", crossing: "uncontrolled" } : {}, "Светофор убран", [...(!cross && t.highway === "traffic_signals" ? ["highway"] : []), ...phases]);
          else change({ highway: "traffic_signals", ...(cross ? { crossing: "traffic_signals" } : {}) }, "Светофор добавлен");
        }}>{isSignal ? "Есть" : "Нет"}</button>
      </div>
      {!onRoad && <p className="hint">Узел не лежит на проезжей дороге: светофор здесь не учитывается (например, железнодорожный сигнал).</p>}
      {isSignal && onRoad && <SignalBox node={node} arms={arms.filter((a) => a.incoming)} change={change} />}

      {onRoad && <CrossingBox node={node} arms={arms} isSignal={isSignal} />}

      {onRoad && (
        <>
          <h3>Вставить шаблон</h3>
          <div className="chips">
            <button onClick={() => makeRoundabout(node.id)} title="Перекресток заменяется кольцом радиусом 18 м, дороги подключаются к нему"><Icon name="roundabout" size={15} />Круговое движение</button>
            <button onClick={() => makeUturn(node.id)} title={isEnd ? "Петля для разворота на конце дороги" : "Петля для разворота справа от дороги"}><Icon name="uturn" size={15} />Разворот 180°</button>
            <button disabled={!isEnd} onClick={() => makeTurn(node.id, "left")} title={isEnd ? "Продолжить дорогу поворотом налево" : "Только на конце дороги"}><Icon name="turnLeft" size={15} />Поворот 90°</button>
            <button disabled={!isEnd} onClick={() => makeTurn(node.id, "right")} title={isEnd ? "Продолжить дорогу поворотом направо" : "Только на конце дороги"}><Icon name="turnRight" size={15} />Поворот 90°</button>
          </div>
        </>
      )}

      <h3>Дороги через узел</h3>
      <div className="chips">{ways.map((w) => <button key={w.id} onClick={() => select({ kind: "way", id: w.id })}>{wayName(w)}</button>)}</div>
      <div className="chips">
        <button onClick={() => setTool("join")} title="Дальше кликните на карте узел или дорогу, к которой присоединить этот узел"><Icon name="join" size={15} />Соединить с...</button>
        <button disabled={ways.length < 2} onClick={() => unjoinNode(node.id)} title="У каждой дороги в этом месте будет свой узел"><Icon name="unjoin" size={15} />Разъединить дороги</button>
      </div>
      <p className="hint">Shift+клик по другому узлу выделит участок дороги между ними.</p>
    </div>
  );
}

// Светофор: общие фазы или свои для каждого подхода (откуда едут машины)
function SignalBox({ node, arms, change }: { node: OsmNode; arms: Arm[]; change: (p: Tags, l: string, r?: string[]) => void }) {
  const t = node.tags;
  const num = (k: string) => (t[k] ? Number(t[k]) : 0);
  // подходы с одной стороны света считаем одним
  const sides = [...new Map(arms.map((a) => [a.side, a])).values()];
  const perKeys = Object.keys(t).filter((k) => /^wayfinders:(green|yellow|red):/.test(k));
  const per = perKeys.length > 0;
  const cycle = num(SIGNAL_KEYS.cycle);

  const toPer = () => {
    // если общие фазы не заданы, берем типовой цикл 60 с
    const def = { green: "27", yellow: "3", red: "30" };
    const p: Tags = { [SIGNAL_KEYS.cycle]: t[SIGNAL_KEYS.cycle] || "60" };
    for (const a of sides) for (const k of ["green", "yellow", "red"] as const) p[phaseKey(k, a.side)] = t[SIGNAL_KEYS[k]] || def[k];
    change(p, "Фазы по подходам");
  };
  // поочередно: подходы одной оси (север-юг или запад-восток) едут вместе
  const byAxis = (c: number) => {
    const y = 3, g = Math.round((c - 2 * y) / 2), p: Tags = { [SIGNAL_KEYS.cycle]: String(c) };
    const axis0 = sides[0] ? sides[0].az % 180 : 0;
    for (const a of sides) {
      const first = Math.abs(((a.az % 180) - axis0 + 270) % 180 - 90) > 45;
      p[phaseKey("green", a.side)] = String(g);
      p[phaseKey("yellow", a.side)] = String(y);
      p[phaseKey("red", a.side)] = String(c - g - y);
      p[`wayfinders:offset:${a.side}`] = first ? "0" : String(g + y);
    }
    change(p, `Фазы поочередно, цикл ${c} с`);
  };

  return (
    <div className="signal-box">
      <h3>Время работы светофора</h3>
      <div className="seg">
        <button className={!per ? "on" : ""} onClick={() => per && change({}, "Общие фазы", [...perKeys, ...Object.keys(t).filter((k) => k.startsWith("wayfinders:offset:"))])}>Общие для всех</button>
        <button className={per ? "on" : ""} disabled={!sides.length} onClick={() => !per && toPer()}>По подходам ({sides.length})</button>
      </div>
      {!per && (
        <>
          <div className="form">
            {([["cycle", "Цикл, с"], ["green", "Зеленый, с"], ["yellow", "Желтый, с"], ["red", "Красный, с"]] as const).map(([k, l]) => (
              <NumField key={k} label={l} value={t[SIGNAL_KEYS[k]] ?? ""} onSave={(v) => change({ [SIGNAL_KEYS[k]]: v }, "Время светофора")} />
            ))}
          </div>
          <PhaseBar g={num(SIGNAL_KEYS.green)} y={num(SIGNAL_KEYS.yellow)} r={num(SIGNAL_KEYS.red)} cycle={cycle} />
          <div className="chips">
            <button onClick={() => change({ [SIGNAL_KEYS.cycle]: "60", [SIGNAL_KEYS.green]: "27", [SIGNAL_KEYS.yellow]: "3", [SIGNAL_KEYS.red]: "30" }, "Время светофора: 60 с")}>Цикл 60 с</button>
            <button onClick={() => change({ [SIGNAL_KEYS.cycle]: "90", [SIGNAL_KEYS.green]: "42", [SIGNAL_KEYS.yellow]: "3", [SIGNAL_KEYS.red]: "45" }, "Время светофора: 90 с")}>Цикл 90 с</button>
          </div>
        </>
      )}
      {per && (
        <>
          <div className="form"><NumField label="Цикл, с" value={t[SIGNAL_KEYS.cycle] ?? ""} onSave={(v) => change({ [SIGNAL_KEYS.cycle]: v }, "Время светофора")} /></div>
          {sides.map((a) => {
            const g = num(phaseKey("green", a.side)), y = num(phaseKey("yellow", a.side)), r = num(phaseKey("red", a.side));
            return (
              <div key={a.side} className="appr">
                <div className="appr-head"><b>{sideRu(a.side)}</b><small>{a.name}</small></div>
                <div className="appr-row">
                  {(["green", "yellow", "red"] as const).map((k) => (
                    <label key={k} className={"ph ph-" + k} title={k === "green" ? "Зеленый, с" : k === "yellow" ? "Желтый, с" : "Красный, с"}>
                      <i />
                      <input type="number" min="0" step="1" defaultValue={t[phaseKey(k, a.side)] ?? ""} key={t[phaseKey(k, a.side)] ?? ""} onBlur={(e) => e.target.value !== (t[phaseKey(k, a.side)] ?? "") && change({ [phaseKey(k, a.side)]: e.target.value }, "Фазы подхода " + sideRu(a.side))} />
                    </label>
                  ))}
                </div>
                <PhaseBar g={g} y={y} r={r} cycle={cycle} small />
              </div>
            );
          })}
          <div className="chips">
            <button onClick={() => byAxis(60)} title="Север-юг и запад-восток едут по очереди">Поочередно, 60 с</button>
            <button onClick={() => byAxis(90)}>Поочередно, 90 с</button>
          </div>
        </>
      )}
    </div>
  );
}

function PhaseBar({ g, y, r, cycle, small }: { g: number; y: number; r: number; cycle: number; small?: boolean }) {
  const sum = g + y + r;
  if (!sum) return null;
  return (
    <>
      <div className="phase-bar" style={small ? { height: 6 } : undefined} title="Фазы светофора">
        <i style={{ flex: g, background: "#3fb265" }} />
        <i style={{ flex: y, background: "#e8b931" }} />
        <i style={{ flex: r, background: "#e5483f" }} />
      </div>
      {!small && <p className="hint">Доля зеленого: {Math.round((g / sum) * 100)}%.</p>}
      {cycle > 0 && sum !== cycle && <p className="hint warn">Сумма фаз {sum} с не равна циклу {cycle} с.</p>}
    </>
  );
}

// Пешеходный переход: через какую дорогу и с какой стороны на какую
function CrossingBox({ node, arms, isSignal }: { node: OsmNode; arms: Arm[]; isSignal: boolean }) {
  const data = useEditor((s) => s.data)!;
  const t = node.tags;
  const fw = crossingOf(node.id);
  const has = t.highway === "crossing" || !!t.crossing || !!fw;
  const signals = t.crossing === "traffic_signals" || isSignal;
  // перекресток: 3 рукава и больше. Светофор сам по себе переход не блокирует: на обычной дороге переход ставится прямо в узел и становится регулируемым
  const junction = new Set(arms.map((a) => a.wayId + ":" + a.nb)).size >= 3;
  const toast = useEditor((s) => s.toast);
  // рукава без повторов: по одной кнопке на дорогу и сторону
  const uniq = [...new Map(arms.map((a) => [a.wayId + ":" + a.nb, a])).values()];
  let fromTo = "";
  if (fw) {
    const a = data.nodes.get(fw.nodeIds[0]), b = data.nodes.get(fw.nodeIds[fw.nodeIds.length - 1]);
    if (a && b) fromTo = `с ${SIDE_ADJ[sideOf(azimuth(node, a))]} стороны на ${SIDE_ADJ[sideOf(azimuth(node, b))]}`;
  }
  const road = fw ? [...data.ways.values()].find((w) => isDrivable(w) && w.nodeIds.includes(node.id)) : undefined;

  return (
    <div>
      <div className="switch">
        <span>Пешеходный переход</span>
        <button className={has ? "on" : ""} title={junction && !has ? "На перекрестке выберите ниже, через какую дорогу переход" : ""}
          onClick={() => (has ? removeCrossing(node.id) : junction ? toast("На перекрестке выберите ниже, через какую дорогу идет переход") : setCrossing(node.id, null, signals))}>{has ? "Есть" : "Нет"}</button>
      </div>
      {fw && (
        <div className="cross-info">
          <p className="hint">Переход через «{wayName(road)}», {fromTo}.</p>
          <div className="chips">
            <button onClick={() => flipCrossing(node.id)}><Icon name="swap" size={15} />Поменять откуда и куда</button>
            <button className={signals ? "on" : ""} onClick={() => setCrossing(node.id, null, !signals)}>{signals ? "Регулируемый" : "Нерегулируемый"}</button>
          </div>
        </div>
      )}
      {has && !fw && (
        <div className="chips"><button onClick={() => setCrossing(node.id, null, signals)} title="Пешеходная дорожка поперек дороги, видна на карте">Нарисовать дорожку перехода</button></div>
      )}
      {junction && !fw && (
        <>
          <p className="hint">Переход через дорогу перекрестка, в 10 м от центра:</p>
          <div className="chips">
            {uniq.map((a) => <button key={a.wayId + ":" + a.nb} onClick={() => setCrossing(node.id, a, signals)}>{SIDE_NOM[a.side]}: {a.name}</button>)}
          </div>
        </>
      )}
    </div>
  );
}

function NumField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  return (
    <>
      <span>{label}</span>
      <input type="number" min="0" step="1" defaultValue={value} key={value} onBlur={(e) => e.target.value !== value && onSave(e.target.value)} />
    </>
  );
}

// ---------- свои шаблоны ----------
function SaveTemplate({ ids }: { ids: number[] }) {
  const [name, setName] = useState<string | null>(null);
  const toast = useEditor((s) => s.toast);
  if (name === null) return <button onClick={() => setName("")} title="Запомнить эти дороги как шаблон и вставлять их в другие места"><Icon name="bookmark" size={15} />Сохранить как шаблон</button>;
  const save = () => {
    const n = name.trim() || "Мой шаблон";
    const tpl = templateFromWays(ids, n);
    if (!tpl) return;
    const list = loadCustom();
    const i = list.findIndex((x) => x.name === n);
    if (i >= 0) list[i] = { ...tpl, id: list[i].id }; else list.push(tpl);
    saveCustom(list);
    toast(i >= 0 ? `Шаблон «${n}» обновлен` : `Шаблон «${n}» сохранен. Он в панели, когда ничего не выделено`);
    setName(null);
  };
  return (
    <span className="save-tpl">
      <input autoFocus placeholder="Название шаблона" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setName(null); }} />
      <button onClick={save}>OK</button>
    </span>
  );
}

// Когда ничего не выделено: подсказка и библиотека своих шаблонов
function LibraryPanel() {
  const [list, setList] = useState<CustomTemplate[]>(loadCustom);
  const [edit, setEdit] = useState<CustomTemplate | null>(null);
  const update = (l: CustomTemplate[]) => { setList(l); saveCustom(l); };
  const insertHere = (tpl: CustomTemplate) => {
    const b = getMapBounds();
    if (!b) return;
    insertTemplate(tpl, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  };
  if (edit) return <TemplateEditor tpl={edit} onCancel={() => setEdit(null)} onSave={(tp) => { const i = list.findIndex((x) => x.id === tp.id); update(i >= 0 ? list.map((x) => (x.id === tp.id ? tp : x)) : [...list, tp]); setEdit(null); }} />;

  return (
    <div className="pane">
      <h3>Ничего не выделено</h3>
      <p className="hint">Кликните по дороге или узлу на карте. Узлы видны при сильном приближении. Найти улицу можно поиском в верхней панели. Shift+клик выделяет несколько дорог.</p>
      <h3>Свои шаблоны</h3>
      <p className="hint">Выделите дороги и нажмите «Сохранить как шаблон» или создайте шаблон по точкам. Шаблон вставляется в центр карты.</p>
      {list.map((tpl) => (
        <div key={tpl.id} className="tpl-row">
          <TemplateSketch tpl={tpl} size={44} />
          <div className="tpl-name"><b>{tpl.name}</b><small>линий: {tpl.lines.length}, точек: {tpl.lines.reduce((s, l) => s + l.pts.length, 0)}</small></div>
          <div className="chips">
            <button onClick={() => insertHere(tpl)}>Вставить</button>
            <button onClick={() => setEdit(tpl)}>Точки</button>
            <button className="x" title="Удалить шаблон" onClick={() => update(list.filter((x) => x.id !== tpl.id))}><Icon name="close" size={14} /></button>
          </div>
        </div>
      ))}
      {!list.length && <p className="hint">Своих шаблонов пока нет.</p>}
      <div className="chips">
        <button onClick={() => setEdit({ id: Date.now().toString(36), name: "Новый шаблон", lines: [{ tags: { highway: "secondary", lanes: "2", maxspeed: "60" }, pts: [[-30, 0], [30, 0]] }] })}><Icon name="plus" size={15} />Новый шаблон по точкам</button>
      </div>
    </div>
  );
}

// Схема шаблона: линии в квадрате size×size
function TemplateSketch({ tpl, size, mark }: { tpl: CustomTemplate; size: number; mark?: boolean }) {
  const pts = tpl.lines.flatMap((l) => l.pts);
  if (!pts.length) return <svg width={size} height={size} />;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = (size - 10) / Math.max(x1 - x0, y1 - y0, 1);
  const sx = (x: number) => 5 + (x - x0) * k + ((size - 10) - (x1 - x0) * k) / 2;
  const sy = (y: number) => 5 + (y1 - y) * k + ((size - 10) - (y1 - y0) * k) / 2;
  return (
    <svg className="tpl-sketch" width={size} height={size}>
      {tpl.lines.map((l, i) => {
        const p = (l.closed ? [...l.pts, l.pts[0]] : l.pts).map((q) => `${sx(q[0])},${sy(q[1])}`).join(" ");
        return <polyline key={i} points={p} fill="none" stroke={l.tags.railway ? "#8264a0" : "currentColor"} strokeWidth={2} strokeLinejoin="round" />;
      })}
      {mark && tpl.lines.map((l, i) => l.pts.map((q, j) => <circle key={i + ":" + j} cx={sx(q[0])} cy={sy(q[1])} r={3} fill="#1f6fd1" />))}
    </svg>
  );
}

// Редактор шаблона по точкам: x на восток, y на север, в метрах от места вставки
function TemplateEditor({ tpl, onSave, onCancel }: { tpl: CustomTemplate; onSave: (t: CustomTemplate) => void; onCancel: () => void }) {
  const [t, setT] = useState<CustomTemplate>(() => JSON.parse(JSON.stringify(tpl)));
  const setLine = (i: number, f: (l: CustomTemplate["lines"][number]) => void) => setT((old) => { const n = JSON.parse(JSON.stringify(old)) as CustomTemplate; f(n.lines[i]); return n; });
  const kinds: [string, string][] = [...Object.entries(ROAD_CLASSES).filter(([k]) => !k.endsWith("_link") || k === "primary_link").map(([k, v]): [string, string] => ["highway=" + k, v.ru]), ["railway=tram", TRACKS.tram], ["railway=rail", TRACKS.rail]];
  const kindOf = (tags: Tags) => (tags.railway ? "railway=" + tags.railway : "highway=" + (tags.highway ?? "secondary"));

  return (
    <div className="pane">
      <input className="title-input" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
      <div className="sub">x - на восток, y - на север, метры от точки вставки</div>
      <TemplateSketch tpl={t} size={140} mark />
      {t.lines.map((l, i) => (
        <div key={i} className="tpl-line">
          <div className="chips">
            <b>Линия {i + 1}</b>
            <select value={kindOf(l.tags)} onChange={(e) => { const [k, v] = e.target.value.split("="); setLine(i, (x) => { if (k === "railway") x.tags = { railway: v }; else { x.tags = { ...x.tags, highway: v }; delete x.tags.railway; } }); }}>
              {kinds.map(([v, ru]) => <option key={v} value={v}>{ru}</option>)}
            </select>
            <label className="hint"><input type="checkbox" checked={!!l.closed} onChange={(e) => setLine(i, (x) => { x.closed = e.target.checked; })} /> Замкнутая</label>
            <button className="x" title="Удалить линию" onClick={() => setT({ ...t, lines: t.lines.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
          </div>
          <table className="pts">
            <tbody>
              {l.pts.map((p, j) => (
                <tr key={j}>
                  <td>{j + 1}</td>
                  {[0, 1].map((c) => <td key={c}><input type="number" step="1" value={p[c]} onChange={(e) => setLine(i, (x) => { x.pts[j][c] = Number(e.target.value) || 0; })} /></td>)}
                  <td><button className="x" title="Удалить точку" disabled={l.pts.length <= 2} onClick={() => setLine(i, (x) => { x.pts.splice(j, 1); })}><Icon name="close" size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="chips"><button onClick={() => setLine(i, (x) => { const last = x.pts[x.pts.length - 1]; x.pts.push([last[0] + 20, last[1]]); })}><Icon name="plus" size={14} />Точка</button></div>
        </div>
      ))}
      <div className="chips">
        <button onClick={() => setT({ ...t, lines: [...t.lines, { tags: { highway: "residential" }, pts: [[0, 0], [0, 30]] }] })}><Icon name="plus" size={14} />Линия</button>
      </div>
      <p className="hint">Одинаковые точки разных линий при вставке становятся общим узлом, так линии связаны между собой.</p>
      <div className="chips">
        <button className="primary" disabled={!t.lines.length} onClick={() => onSave(t)}>Сохранить</button>
        <button onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}
