import { useMemo, useState, type ReactNode } from "react";
import "./props.css";
import {
  useEditor, reverseWay, deleteWay, deleteWays, deleteNode, setNodeTags, setWayTags, unjoinNode, patchSelection,
  makeRoundabout, makeUturn, makeTurn, insertBridge, setCrossing, removeCrossing, flipCrossing, crossingOf,
  embeddedTram, setTramOnRoad, templateFromWays, insertTemplate, extraCorners, cleanBuildingCorners,
} from "../model/store";
import {
  ROAD_CLASSES, CITY_CLASSES, CLASS_HINT, ROAD_CATEGORIES, CATEGORY_KEY, SURFACES, SIGNAL_KEYS, TRACKS,
  isDrivable, isSignalTagged, isTrack, lanesOf, maxSpeed, nodeArms, phaseKey, sideRu, sideOf, azimuth, surfaceName, wayName, type Arm,
} from "../model/roads";
import { distM, wayLengthM } from "../model/geo";
import { poiKind, walkRadius } from "../model/poi";
import { routesAtNode, ROUTE_KINDS, ROUTE_RU, setStop, stopKindOf, useRoute, type RouteKind } from "../model/routes";
import { TEMPLATES, MODIFIERS, loadCustom, saveCustom, type CustomTemplate } from "../model/templates";
import { calcWay, capacityPerLane, clampPhi, frictionOf, FRICTION_KEY, PHI_MAX, PHI_MIN, zLevel, Z_COLORS, Z_TEXT } from "../model/calc";
import { getMapBounds } from "./MapView";
import type { OsmNode, OsmWay, Tags } from "../osm/types";
import Icon from "./Icon";
import LanePanel from "./LanePanel";
import GraphSummary from "./GraphSummary";
import { BUS_LANE_KEYS } from "../model/lanes";
import { locale, nameKey, nameOf, toLatin, tr } from "../i18n";

const fmt = (x: number, n = 0) => x.toLocaleString(locale(), { minimumFractionDigits: n, maximumFractionDigits: n });
const SPEEDS = ["20", "30", "40", "50", "60", "70", "80", "90", "110", "RU:urban"];
const speedText = (v: string) => (v === "RU:urban" ? tr("Городская (60)") : v + tr(" км/ч"));
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
  // сцепление: свое у дороги (тег) или по покрытию из нормативов
  const ownPhi = get((w) => w.tags[FRICTION_KEY] ?? "");
  const normPhi = get((w) => String(frictionOf({ ...w, tags: { ...w.tags, [FRICTION_KEY]: "" } }, norms).phi));
  const bus = get((w) => (w.tags.busway === "lane" ? "both" : w.tags["busway:right"] === "lane" ? "right" : "no"));
  const n = lanes === null ? null : Number(lanes);

  return (
    <div className="form">
      <span>{tr("Класс")}</span>
      <ClassPicker get={get} set={set} />
      <span>{tr("Движение")}</span>
      <div className="seg">
        {([["no", "twoWay", tr("Обе"), tr("Движение в обе стороны")], ["yes", "arrowRight", tr("Туда"), tr("Одностороннее по направлению линии")], ["-1", "arrowLeft", tr("Обратно"), tr("Одностороннее против направления линии")]] as const).map(([v, ic, l, t]) => (
          <button key={v} className={ow === v ? "on" : ""} title={t} onClick={() => set({ oneway: v }, tr("Направление"))}><Icon name={ic} size={15} />{l}</button>
        ))}
      </div>
      <span>{tr("Полосы")}</span>
      <div className="step">
        <button disabled={n === null} onClick={() => set({ lanes: String(Math.max(1, n! - 1)) }, tr("Полосы"), ["lanes:forward", "lanes:backward"])} title={tr("Меньше полос")}><Icon name="minus" size={14} /></button>
        <b>{n ?? tr("разные")}</b>
        <button disabled={n === null} onClick={() => set({ lanes: String(Math.min(8, n! + 1)) }, tr("Полосы"), ["lanes:forward", "lanes:backward"])} title={tr("Больше полос")}><Icon name="plus" size={14} /></button>
        {n === null && <select value="" onChange={(e) => set({ lanes: e.target.value }, tr("Полосы"), ["lanes:forward", "lanes:backward"])}><option value="">{tr("Задать всем")}</option>{[1, 2, 3, 4, 5, 6].map((k) => <option key={k} value={k}>{k}</option>)}</select>}
        {get((w) => w.tags.lanes ?? "") === "" && <span className="tag-warn">{tr("не задано")}</span>}
      </div>
      <span>{tr("Скорость")}</span>
      <select value={speed ?? "*"} onChange={(e) => set({ maxspeed: e.target.value }, tr("Скорость"))}>
        {speed === null && <option value="*">{tr("Разная")}</option>}
        <option value="">{tr("Не задана")}{defSpeed ? ` (${defSpeed})` : ""}</option>
        {SPEEDS.map((v) => <option key={v} value={v}>{speedText(v)}</option>)}
        {speed && !SPEEDS.includes(speed) && <option value={speed}>{speed}</option>}
      </select>
      <span>{tr("Покрытие")}</span>
      <select value={surface ?? "*"} onChange={(e) => set({ surface: e.target.value }, tr("Покрытие"))}>
        {surface === null && <option value="*">{tr("Разное")}</option>}
        <option value="">{tr("Не задано")}</option>
        {Object.entries(SURFACES).map(([k, v]) => <option key={k} value={k}>{v.ru} (φ {norms.friction[k] ?? v.k})</option>)}
        {surface && !SURFACES[surface] && <option value={surface}>{surfaceName(surface)} {" "}{tr("(из файла)")}</option>}
      </select>
      <span title={tr("Коэффициент сцепления шины с покрытием, от {0} до {1}. Пусто - по покрытию из нормативов", PHI_MIN, PHI_MAX)}>{tr("Сцепление φ")}</span>
      <div className="step">
        <input className="phi-input" type="number" step="0.05" min={PHI_MIN} max={PHI_MAX} key={"phi" + ownPhi + normPhi} defaultValue={ownPhi ?? ""} placeholder={normPhi ?? tr("разное")}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          onBlur={(e) => {
            const s = e.target.value.trim().replace(",", ".");
            if (s === "") { if (ownPhi) set({}, tr("Сцепление по покрытию"), [FRICTION_KEY]); return; }
            const c = clampPhi(Number(s));
            if (c === null) { e.target.value = ownPhi ?? ""; return; }
            e.target.value = String(c);
            if (String(c) !== ownPhi) set({ [FRICTION_KEY]: String(c) }, tr("Сцепление φ"));
          }} />
        <small className="hint">{ownPhi ? tr("свое у дороги") : tr("по покрытию")}</small>
      </div>
      <span title={tr("Мост или тоннель")}>{tr("Искусственные сооружения")}</span>
      <div className="seg">
        {(["ground", "bridge", "tunnel"] as const).map((v) => (
          <button key={v} className={level === v ? "on" : ""} onClick={() => set(MODIFIERS[v].tags, MODIFIERS[v].name, MODIFIERS[v].remove)}>{v === "tunnel" ? tr("Тоннель") : v === "bridge" ? tr("Мост") : tr("Нет")}</button>
        ))}
      </div>
      <span title={tr("Выделенная полоса для автобусов")}>{tr("Автобусная полоса")}</span>
      <div className="seg">
        {([["no", tr("Нет")], ["right", tr("Справа")], ["both", tr("С двух сторон")]] as const).map(([v, l]) => (
          <button key={v} className={bus === v ? "on" : ""} onClick={() => set(v === "no" ? {} : v === "right" ? { "busway:right": "lane", "lanes:bus": "1" } : { busway: "lane", "lanes:bus": "2" }, v === "no" ? tr("Автобусная полоса убрана") : tr("Автобусная полоса"), [...(v === "no" ? ["busway", "busway:right", "lanes:bus"] : v === "right" ? ["busway"] : ["busway:right"]), ...BUS_LANE_KEYS])}>{l}</button>
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
  const label = hw === null ? tr("Разные классы") : catInfo ? catInfo.ru : ROAD_CLASSES[hw]?.ru ?? hw;
  const color = hw && ROAD_CLASSES[hw] ? ROAD_CLASSES[hw].color : [200, 200, 200];
  const pick = (patch: Tags, name: string, remove: string[] = []) => { set(patch, tr("Класс дороги: ") + name, remove); setOpen(false); };
  const lanesSet = get((w) => (w.tags.lanes ? "y" : "")) === "y", speedSet = get((w) => (w.tags.maxspeed ? "y" : "")) === "y";

  return (
    <div className="cls">
      <button className="cls-cur" onClick={() => setOpen(!open)} title={tr("Выбрать класс дороги")}>
        <i className="cls-sw" style={{ background: `rgb(${color.join(",")})` }} />
        <span>{label}</span>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} className="muted" />
      </button>
      {open && (
        <div className="cls-menu">
          <div className="seg cls-tabs">
            <button className={group === "city" ? "on" : ""} onClick={() => setGroup("city")}>{tr("Улицы города")}</button>
            <button className={group === "public" ? "on" : ""} onClick={() => setGroup("public")}>{tr("Параметры класса")}</button>
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
                <thead><tr><th>{tr("Класс дороги")}</th><th>{tr("Категория")}</th><th>{tr("Интенсивность, прив. ед./сут")}</th></tr></thead>
                <tbody>
                  {ROAD_CATEGORIES.map((c, i) => {
                    // класс пишем один раз на группу строк, как в таблице ГОСТ
                    const first = i === 0 || ROAD_CATEGORIES[i - 1].cls !== c.cls;
                    const span = ROAD_CATEGORIES.filter((x) => x.cls === c.cls).length;
                    const choose = () => pick({ highway: c.highway, [CATEGORY_KEY]: c.id, ...(lanesSet ? {} : { lanes: String(c.lanes) }), ...(speedSet ? {} : { maxspeed: String(c.speed) }) }, c.ru);
                    return (
                      <tr key={c.id} className={cat === c.id ? "on" : ""}>
                        {first && <td rowSpan={span} className="cat-cls">{c.cls}</td>}
                        <td className="cat-pick" onClick={choose} title={tr("Выбрать: {0}", c.ru)}>
                          <i className="cls-sw" style={{ background: `rgb(${ROAD_CLASSES[c.highway].color.join(",")})` }} />
                          <b>{c.cat}</b>
                        </td>
                        <td className="cat-pick" onClick={choose}>{c.flow}<small>{c.lanes} {" "}{tr("пол.,")}{" "}{c.speed} {" "}{tr("км/ч")}</small></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="hint">{tr("Дорога IВ имеет те же геометрические характеристики, что и IБ, но допускает пересечения в одном уровне со светофорами. Кликните категорию: если полосы и скорость не заданы, ставятся типовые.")}</p>
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
          <button className="icon-btn" onClick={() => reverseWay(way.id)} title={tr("Развернуть направление (R)")}><Icon name="reverse" size={16} /></button>
          <button className="icon-btn danger" onClick={() => deleteWay(way.id)} title={tr("Удалить дорогу (Delete)")}><Icon name="trash" size={16} /></button>
        </>}>
          <input className="title-input" defaultValue={t[nameKey()] ?? ""} key={way.id + nameKey() + (t[nameKey()] ?? "")} placeholder={wayName(way)} title={tr("Название улицы, можно изменить")} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} onBlur={(e) => e.target.value !== (t[nameKey()] ?? "") && change({ [nameKey()]: e.target.value }, tr("Название"))} />
        </Head>
        <div className="sub">{tr("Дорога")}{" "}{way.id}{way.id < 0 ? tr(" (новая)") : ""} · {way.nodeIds.length} {" "}{tr("узлов ·")}{" "}{fmt(L)} {" "}{tr("м")}</div>
      </div>

      <RoadFields get={(f) => f(way)} set={change} />
      <div className="switch">
        <span title={tr("Трамвайные пути по проезжей части. Концы сами стыкуются с путями рядом (до 15 м)")}>{tr("Трамвай по дороге")}</span>
        <button className={tram ? "on" : ""} onClick={() => setTramOnRoad(way.id, !tram)}>{tram ? tr("Есть") : tr("Нет")}</button>
      </div>

      <LanePanel way={way} />

      <div className="mini-calc">
        <div><small>{tr("V своб")}</small><b>{fmt(c.Vfree)} {" "}{tr("км/ч")}</b><small>{c.kSurface < 1 ? `${fmt(c.Vmax)} × ${c.kSurface.toFixed(2)} (φ ${c.phi})` : tr("по знаку")}</small></div>
        <div><small>{tr("T своб")}</small><b>{fmt(c.Tfree, 2)} {" "}{tr("мин")}</b><small>{tr("L / V своб")}</small></div>
        <div title={tr("Пропускная способность: число полос × норматив полосы (вкладка «Нормативы»)")}><small>{tr("P, авт/ч")}</small><b>{fmt(c.P)}</b><small>{c.lanes} {" "}{tr("пол. ×")}{" "}{fmt(capacityPerLane(way, norms))}</small></div>
        {c.Z !== null && <div title={tr("Коэффициент загрузки Z = N / P, пороги из нормативов")}><small>Z</small><b><span className="zpill" style={{ background: `rgb(${Z_COLORS[zLevel(c.Z, norms)].join(",")})` }}>{fmt(c.Z, 2)}</span></b><small>{Z_TEXT[zLevel(c.Z, norms)]}</small></div>}
      </div>

      <h3>{tr("Шаблоны")}</h3>
      <div className="chips">
        {Object.entries(TEMPLATES).filter(([, v]) => !v.kind).map(([k, v]) => <button key={k} onClick={() => change(v.tags, tr("Шаблон: ") + v.name, ["lanes:forward", "lanes:backward", CATEGORY_KEY])}>{v.name}</button>)}
      </div>
      <div className="chips">
        <button onClick={() => insertBridge(way.id)} title={tr("Участок дороги 50 м над пересечением с другой дорогой (или в середине) становится мостом")}><Icon name="bridge" size={15} />{tr("Вставить мост")}</button>
        <SaveTemplate ids={[way.id]} />
      </div>
      <p className="hint">{tr("Shift+клик по другим дорогам выделяет несколько сразу. Shift+клик по двум узлам выделяет участок между ними.")}</p>

      <div className="chips">
        <button className={inAnalysis ? "on" : ""} onClick={() => { setAnalysis(inAnalysis ? analysis.filter((x) => x !== way.id) : [...analysis, way.id]); if (!inAnalysis) window.dispatchEvent(new CustomEvent("wf-open-calc")); }}>{inAnalysis ? tr("Убрать из расчета") : tr("Добавить в расчет")}</button>
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
        <div className="title-input">{section ? tr("Участок между узлами") : tr("Выделено дорог: {0}", ws.length)}</div>
        <div className="sub">{section ? tr("через {0} {1} · ", ws.length, ws.length === 1 ? tr("дорогу") : tr("дорог")) : ""}{fmt(L)} {" "}{tr("м")}</div>
      </div>
      {section && <p className="hint">{tr("Изменения применятся только к участку: дороги на его краях разрежутся сами.")}</p>}
      {roads.length > 0 && <RoadFields get={(f) => common(roads, f)} set={(patch, label, remove = []) => patchSelection(patch, remove, label)} />}
      {roads.length < ws.length && <p className="hint">{tr("Кроме дорог выделены пути или дорожки:")}{" "}{ws.length - roads.length}{tr(". Их параметры здесь не меняются.")}</p>}
      <div className="chips">{ws.slice(0, 12).map((w) => <button key={w.id} onClick={() => select({ kind: "way", id: w.id })}>{wayName(w)}</button>)}{ws.length > 12 && <span className="hint">{tr("и еще")}{" "}{ws.length - 12}</span>}</div>
      <div className="chips">
        {!section && <SaveTemplate ids={ids} />}
        <button onClick={() => select(null)}>{tr("Снять выделение")}</button>
        {!section && <button className="danger" onClick={() => deleteWays(ids)}>{tr("Удалить все (")}{ids.length})</button>}
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
  const kind = building ? tr("Здание") : isTrack(way) ? TRACKS[t.railway] : t.footway === "crossing" ? tr("Пешеходный переход") : t.highway ? tr("Пешеходная или служебная дорожка") : tr("Линия");
  return (
    <div className="pane">
      <div>
        <Head actions={<>
          {!building && <button className="icon-btn" onClick={() => reverseWay(way.id)} title={tr("Развернуть направление (R)")}><Icon name="reverse" size={16} /></button>}
          <button className="icon-btn danger" onClick={() => deleteWay(way.id)} title={(building ? tr("Удалить здание") : tr("Удалить")) + " (Delete)"}><Icon name="trash" size={16} /></button>
        </>}>
          <input className="title-input" defaultValue={t[nameKey()] ?? ""} key={way.id + nameKey() + (t[nameKey()] ?? "")} placeholder={nameOf(t) || kind} title={tr("Название, можно изменить")} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} onBlur={(e) => e.target.value !== (t[nameKey()] ?? "") && change({ [nameKey()]: e.target.value }, tr("Название"))} />
        </Head>
        <div className="sub">{kind} · {way.nodeIds.length} {" "}{tr("узлов ·")}{" "}{building ? tr("площадь застройки {0} м²", fmt(areaM2(data, way))) : tr("{0} м", fmt(wayLengthM(data, way)))}</div>
      </div>
      {building && (
        <div className="form">
          <NumField label={tr("Этажей")} value={t["building:levels"] ?? ""} onSave={(v) => change({ "building:levels": v }, tr("Этажность здания"))} />
          <span>{tr("Высота")}</span>
          <span>{tr("около")}{" "}{fmt((parseFloat(t["building:levels"] ?? "") || 3) * 3)} {" "}{tr("м (3 м на этаж), так здание видно в 3D")}</span>
        </div>
      )}
      {building && extraCorners(data, way).length > 0 && (
        <div className="chips"><button onClick={() => cleanBuildingCorners(way.id)}>{tr("Убрать лишние углы (")}{extraCorners(data, way).length})</button></div>
      )}
      {building && <p className="hint">{tr("Перенести здание: потяните его мышью. Угол: потяните белую точку, Shift+клик по ней убирает угол, а угол, оставленный на прямой стене, убирается сам. Новый угол: нажмите на стену в любом месте (или на синюю точку посередине) и тяните, из нового угла можно сделать следующий. Здание нельзя поставить на дорогу. Удалить: корзина вверху панели или Delete. Новое здание: инструмент «Нарисовать» (W), шаблон «Здание».")}</p>}
      {isTrack(way) && (
        <div className="form">
          <span>{tr("Вид")}</span>
          <div className="seg">
            {(["tram", "rail"] as const).map((k) => <button key={k} className={t.railway === k ? "on" : ""} onClick={() => change({ railway: k }, tr("Вид путей"))} title={TRACKS[k]}>{k === "tram" ? tr("Трамвай") : tr("Ж/д")}</button>)}
          </div>
          {t.embedded === "yes" && <><span>{tr("Где")}</span><span>{tr("По проезжей части дороги")}</span></>}
        </div>
      )}
      {isTrack(way) && <p className="hint">{tr("Рельсы рисуются инструментом «Нарисовать дорогу» (W) с шаблоном путей. Концы ближе 15 м к другим путям стыкуются сами, на пересечении с дорогой ставится переезд.")}</p>}
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
const SIDE_NOM: Record<string, string> = { get N() { return tr("Север"); }, get NE() { return tr("Северо-восток"); }, get E() { return tr("Восток"); }, get SE() { return tr("Юго-восток"); }, get S() { return tr("Юг"); }, get SW() { return tr("Юго-запад"); }, get W() { return tr("Запад"); }, get NW() { return tr("Северо-запад"); } };
const SIDE_ADJ: Record<string, string> = { get N() { return tr("северной"); }, get NE() { return tr("северо-восточной"); }, get E() { return tr("восточной"); }, get SE() { return tr("юго-восточной"); }, get S() { return tr("южной"); }, get SW() { return tr("юго-западной"); }, get W() { return tr("западной"); }, get NW() { return tr("северо-западной"); } };

// Остановка: название и вид транспорта. Для любой другой точки без дорожных тегов - кнопки «Сделать остановкой»
function StopBox({ node, stop }: { node: OsmNode; stop: boolean }) {
  const t = node.tags;
  const kind = stopKindOf(t);
  if (!stop) {
    if (t.highway || t.railway || t.public_transport) return null;
    return (
      <>
        <h3>{tr("Сделать остановкой")}</h3>
        <div className="chips">{ROUTE_KINDS.map((k) => <button key={k} onClick={() => setStop(node.id, k, t.name ?? "")}>{ROUTE_RU[k]}</button>)}</div>
      </>
    );
  }
  return (
    <div className="form">
      <span>{tr("Название")}</span>
      <input defaultValue={t.name ?? ""} key={node.id + (t.name ?? "")} placeholder={tr("Остановка без названия")}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={(e) => { if (e.target.value.trim() !== (t.name ?? "")) setStop(node.id, kind, e.target.value); }} />
      <span>{tr("Транспорт")}</span>
      <div className="seg">{ROUTE_KINDS.map((k: RouteKind) => <button key={k} className={kind === k ? "on" : ""} onClick={() => kind !== k && setStop(node.id, k, t.name ?? "")}>{ROUTE_RU[k]}</button>)}</div>
    </div>
  );
}

// Остановка: зона пешей доступности (круг на карте) и сколько домов в нее попадает
function WalkZone({ node }: { node: OsmNode }) {
  const data = useEditor((s) => s.data)!;
  const version = useEditor((s) => s.version);
  const r = walkRadius(node);
  const kind = poiKind(node);
  // дома в зоне: центр контура здания ближе радиуса
  const houses = useMemo(() => {
    if (!r) return 0;
    let n = 0;
    for (const w of data.ways.values()) {
      if (!w.tags.building || w.tags.building === "no") continue;
      let lat = 0, lon = 0, c = 0;
      for (const id of w.nodeIds) { const p = data.nodes.get(id); if (p) { lat += p.lat; lon += p.lon; c++; } }
      if (c && distM(node.lat, node.lon, lat / c, lon / c) <= r) n++;
    }
    return n;
  }, [data, version, node.id, r]); // eslint-disable-line react-hooks/exhaustive-deps
  const routes = useMemo(() => (r ? routesAtNode(data, node.id) : []), [data, version, node.id, r]); // eslint-disable-line react-hooks/exhaustive-deps
  const setRoute = useRoute((s) => s.set);
  const routeId = useRoute((s) => s.id);
  if (!r) return null;
  return (
    <div className="walk-zone">
      {routes.length > 0 && (
        <>
          <h3>{tr("Маршруты через остановку")}</h3>
          <div className="route-chips">
            {routes.map((x) => (
              <button key={x.id} className={x.id === routeId ? "on" : ""} style={{ borderColor: `rgb(${x.color.join(",")})` }} onClick={() => setRoute(x.id === routeId ? null : x.id)} title={tr("{0} {1}: {2}. Показать на карте", ROUTE_RU[x.kind], x.ref, toLatin(x.name))}>
                <i style={{ background: `rgb(${x.color.join(",")})` }} />{toLatin(x.ref)}
              </button>
            ))}
          </div>
        </>
      )}
      <h3>{tr("Пешая доступность")}</h3>
      <div className="walk-row"><i /><span>{tr("Зона пешей доступности:")}{" "}<b>{r} {" "}{tr("м")}</b></span></div>
      <p className="hint">{tr("Круг на карте: столько обычно проходят до остановки пешком (")}{kind === "tram" ? tr("норматив для трамвая 400-600 м") : tr("норматив для автобуса и троллейбуса 300-400 м")}{tr(", взято среднее). Домов в зоне:")}{" "}{houses}{houses === 0 ? tr(" (здания не загружены или их нет рядом)") : ""}.</p>
    </div>
  );
}

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
  const stop = walkRadius(node) !== null; // остановка автобуса, троллейбуса или трамвая
  const isEnd = roads.length === 1 && (roads[0].nodeIds[0] === node.id || roads[0].nodeIds[roads[0].nodeIds.length - 1] === node.id);

  return (
    <div className="pane">
      <div>
        <Head actions={<button className="icon-btn danger" onClick={() => deleteNode(node.id)} title={tr("Удалить узел (Delete)")}><Icon name="trash" size={16} /></button>}>
          <div className="title-input">{roads.length >= 3 ? tr("Перекресток, {0} дорог", roads.length) : roads.length === 2 ? tr("Стык двух дорог") : roads.length === 1 ? (isEnd ? tr("Конец дороги") : tr("Узел дороги")) : stop ? `${poiKind(node) === "tram" ? tr("Трамвайная остановка") : tr("Остановка")}${t.name ? " " + tr("«{0}»", nameOf(t)) : ""}` : tr("Отдельная точка")}</div>
        </Head>
        <div className="sub">{tr("Узел")}{" "}{node.id} · {node.lat.toFixed(6)}, {node.lon.toFixed(6)}</div>
      </div>

      {(onRoad || isSignal) && <div className="switch">
        <span>{tr("Светофор")}</span>
        <button className={isSignal ? "on" : ""} disabled={!onRoad && !isSignal} onClick={() => {
          // переход в этом узле остается: без светофора нерегулируемый, со светофором регулируемый
          const cross = t.highway === "crossing" || !!t.crossing;
          const phases = Object.keys(t).filter((k) => k.startsWith("wayfinders:") && k !== "wayfinders:category");
          if (isSignal) change(cross ? { highway: "crossing", crossing: "uncontrolled" } : {}, tr("Светофор убран"), [...(!cross && t.highway === "traffic_signals" ? ["highway"] : []), ...phases]);
          else change({ highway: "traffic_signals", ...(cross ? { crossing: "traffic_signals" } : {}) }, tr("Светофор добавлен"));
        }}>{isSignal ? tr("Есть") : tr("Нет")}</button>
      </div>}
      <StopBox node={node} stop={stop} />
      <WalkZone node={node} />
      {!onRoad && isSignal && <p className="hint">{tr("Узел не лежит на проезжей дороге: светофор здесь не учитывается (например, железнодорожный сигнал).")}</p>}
      {isSignal && onRoad && <SignalBox node={node} arms={arms.filter((a) => a.incoming)} change={change} />}

      {onRoad && <CrossingBox node={node} arms={arms} isSignal={isSignal} />}

      {onRoad && (
        <>
          <h3>{tr("Вставить шаблон")}</h3>
          <div className="chips">
            <button onClick={() => makeRoundabout(node.id)} title={tr("Перекресток заменяется кольцом радиусом 18 м, дороги подключаются к нему")}><Icon name="roundabout" size={15} />{tr("Круговое движение")}</button>
            <button onClick={() => makeUturn(node.id)} title={isEnd ? tr("Петля для разворота на конце дороги") : tr("Петля для разворота справа от дороги")}><Icon name="uturn" size={15} />{tr("Разворот 180°")}</button>
            <button disabled={!isEnd} onClick={() => makeTurn(node.id, "left")} title={isEnd ? tr("Продолжить дорогу поворотом налево") : tr("Только на конце дороги")}><Icon name="turnLeft" size={15} />{tr("Поворот 90°")}</button>
            <button disabled={!isEnd} onClick={() => makeTurn(node.id, "right")} title={isEnd ? tr("Продолжить дорогу поворотом направо") : tr("Только на конце дороги")}><Icon name="turnRight" size={15} />{tr("Поворот 90°")}</button>
          </div>
        </>
      )}

      <h3>{tr("Дороги через узел")}</h3>
      <div className="chips">{ways.map((w) => <button key={w.id} onClick={() => select({ kind: "way", id: w.id })}>{wayName(w)}</button>)}</div>
      <div className="chips">
        <button onClick={() => setTool("join")} title={tr("Дальше кликните на карте узел или дорогу, к которой присоединить этот узел")}><Icon name="join" size={15} />{tr("Соединить с...")}</button>
        <button disabled={ways.length < 2} onClick={() => unjoinNode(node.id)} title={tr("У каждой дороги в этом месте будет свой узел")}><Icon name="unjoin" size={15} />{tr("Разъединить дороги")}</button>
      </div>
      <p className="hint">{tr("Shift+клик по другому узлу выделит участок дороги между ними.")}</p>
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
    change(p, tr("Фазы по подходам"));
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
    change(p, tr("Фазы поочередно, цикл {0} с", c));
  };

  return (
    <div className="signal-box">
      <h3>{tr("Время работы светофора")}</h3>
      <div className="seg">
        <button className={!per ? "on" : ""} onClick={() => per && change({}, tr("Общие фазы"), [...perKeys, ...Object.keys(t).filter((k) => k.startsWith("wayfinders:offset:"))])}>{tr("Общие для всех")}</button>
        <button className={per ? "on" : ""} disabled={!sides.length} onClick={() => !per && toPer()}>{tr("По подходам (")}{sides.length})</button>
      </div>
      {!per && (
        <>
          <div className="form">
            {([["cycle", tr("Цикл, с")], ["green", tr("Зеленый, с")], ["yellow", tr("Желтый, с")], ["red", tr("Красный, с")]] as const).map(([k, l]) => (
              <NumField key={k} label={l} value={t[SIGNAL_KEYS[k]] ?? ""} onSave={(v) => change({ [SIGNAL_KEYS[k]]: v }, tr("Время светофора"))} />
            ))}
          </div>
          <PhaseBar g={num(SIGNAL_KEYS.green)} y={num(SIGNAL_KEYS.yellow)} r={num(SIGNAL_KEYS.red)} cycle={cycle} />
          <div className="chips">
            <button onClick={() => change({ [SIGNAL_KEYS.cycle]: "60", [SIGNAL_KEYS.green]: "27", [SIGNAL_KEYS.yellow]: "3", [SIGNAL_KEYS.red]: "30" }, tr("Время светофора: 60 с"))}>{tr("Цикл 60 с")}</button>
            <button onClick={() => change({ [SIGNAL_KEYS.cycle]: "90", [SIGNAL_KEYS.green]: "42", [SIGNAL_KEYS.yellow]: "3", [SIGNAL_KEYS.red]: "45" }, tr("Время светофора: 90 с"))}>{tr("Цикл 90 с")}</button>
          </div>
        </>
      )}
      {per && (
        <>
          <div className="form"><NumField label={tr("Цикл, с")} value={t[SIGNAL_KEYS.cycle] ?? ""} onSave={(v) => change({ [SIGNAL_KEYS.cycle]: v }, tr("Время светофора"))} /></div>
          {sides.map((a) => {
            const g = num(phaseKey("green", a.side)), y = num(phaseKey("yellow", a.side)), r = num(phaseKey("red", a.side));
            return (
              <div key={a.side} className="appr">
                <div className="appr-head"><b>{sideRu(a.side)}</b><small>{a.name}</small></div>
                <div className="appr-row">
                  {(["green", "yellow", "red"] as const).map((k) => (
                    <label key={k} className={"ph ph-" + k} title={k === "green" ? tr("Зеленый, с") : k === "yellow" ? tr("Желтый, с") : tr("Красный, с")}>
                      <i />
                      <input type="number" min="0" step="1" defaultValue={t[phaseKey(k, a.side)] ?? ""} key={t[phaseKey(k, a.side)] ?? ""} onBlur={(e) => e.target.value !== (t[phaseKey(k, a.side)] ?? "") && change({ [phaseKey(k, a.side)]: e.target.value }, tr("Фазы подхода ") + sideRu(a.side))} />
                    </label>
                  ))}
                </div>
                <PhaseBar g={g} y={y} r={r} cycle={cycle} small />
              </div>
            );
          })}
          <div className="chips">
            <button onClick={() => byAxis(60)} title={tr("Север-юг и запад-восток едут по очереди")}>{tr("Поочередно, 60 с")}</button>
            <button onClick={() => byAxis(90)}>{tr("Поочередно, 90 с")}</button>
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
      <div className="phase-bar" style={small ? { height: 6 } : undefined} title={tr("Фазы светофора")}>
        <i style={{ flex: g, background: "#3fb265" }} />
        <i style={{ flex: y, background: "#e8b931" }} />
        <i style={{ flex: r, background: "#e5483f" }} />
      </div>
      {!small && <p className="hint">{tr("Доля зеленого:")}{" "}{Math.round((g / sum) * 100)}%.</p>}
      {cycle > 0 && sum !== cycle && <p className="hint warn">{tr("Сумма фаз")}{" "}{sum} {" "}{tr("с не равна циклу")}{" "}{cycle} {" "}{tr("с.")}</p>}
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
    if (a && b) fromTo = tr("с {0} стороны на {1}", SIDE_ADJ[sideOf(azimuth(node, a))], SIDE_ADJ[sideOf(azimuth(node, b))]);
  }
  const road = fw ? [...data.ways.values()].find((w) => isDrivable(w) && w.nodeIds.includes(node.id)) : undefined;

  return (
    <div>
      <div className="switch">
        <span>{tr("Пешеходный переход")}</span>
        <button className={has ? "on" : ""} title={junction && !has ? tr("На перекрестке выберите ниже, через какую дорогу переход") : ""}
          onClick={() => (has ? removeCrossing(node.id) : junction ? toast(tr("На перекрестке выберите ниже, через какую дорогу идет переход")) : setCrossing(node.id, null, signals))}>{has ? tr("Есть") : tr("Нет")}</button>
      </div>
      {fw && (
        <div className="cross-info">
          <p className="hint">{tr("Переход через «")}{wayName(road)}», {fromTo}.</p>
          <div className="chips">
            <button onClick={() => flipCrossing(node.id)}><Icon name="swap" size={15} />{tr("Поменять откуда и куда")}</button>
            <button className={signals ? "on" : ""} onClick={() => setCrossing(node.id, null, !signals)}>{signals ? tr("Регулируемый") : tr("Нерегулируемый")}</button>
          </div>
        </div>
      )}
      {has && !fw && (
        <div className="chips"><button onClick={() => setCrossing(node.id, null, signals)} title={tr("Пешеходная дорожка поперек дороги, видна на карте")}>{tr("Нарисовать дорожку перехода")}</button></div>
      )}
      {junction && !fw && (
        <>
          <p className="hint">{tr("Переход через дорогу перекрестка, в 10 м от центра:")}</p>
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
      {/* сохраняется по Enter или когда поле теряет фокус */}
      <input type="number" min="0" step="1" defaultValue={value} key={value} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} onBlur={(e) => e.target.value !== value && onSave(e.target.value)} />
    </>
  );
}

// ---------- свои шаблоны ----------
function SaveTemplate({ ids }: { ids: number[] }) {
  const [name, setName] = useState<string | null>(null);
  const toast = useEditor((s) => s.toast);
  if (name === null) return <button onClick={() => setName("")} title={tr("Запомнить эти дороги как шаблон и вставлять их в другие места")}><Icon name="bookmark" size={15} />{tr("Сохранить как шаблон")}</button>;
  const save = () => {
    const n = name.trim() || tr("Мой шаблон");
    const tpl = templateFromWays(ids, n);
    if (!tpl) return;
    const list = loadCustom();
    const i = list.findIndex((x) => x.name === n);
    if (i >= 0) list[i] = { ...tpl, id: list[i].id }; else list.push(tpl);
    saveCustom(list);
    toast(i >= 0 ? tr("Шаблон «{0}» обновлен", n) : tr("Шаблон «{0}» сохранен. Он в панели, когда ничего не выделено", n));
    setName(null);
  };
  return (
    <span className="save-tpl">
      <input autoFocus placeholder={tr("Название шаблона")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setName(null); }} />
      <button onClick={save}>OK</button>
    </span>
  );
}

// Когда ничего не выделено: подсказка, библиотека своих шаблонов и сводка по графу
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
      <h3>{tr("Ничего не выделено")}</h3>
      <p className="hint">{tr("Кликните по дороге или узлу на карте. Узлы видны при сильном приближении. Найти улицу можно поиском в верхней панели. Shift+клик выделяет несколько дорог.")}</p>
      <h3>{tr("Свои шаблоны")}</h3>
      <p className="hint">{tr("Выделите дороги и нажмите «Сохранить как шаблон» или создайте шаблон по точкам. Шаблон вставляется в центр карты.")}</p>
      {list.map((tpl) => (
        <div key={tpl.id} className="tpl-row">
          <TemplateSketch tpl={tpl} size={44} />
          <div className="tpl-name"><b>{tpl.name}</b><small>{tr("линий:")}{" "}{tpl.lines.length}{tr(", точек:")}{" "}{tpl.lines.reduce((s, l) => s + l.pts.length, 0)}</small></div>
          <div className="chips">
            <button onClick={() => insertHere(tpl)}>{tr("Вставить")}</button>
            <button onClick={() => setEdit(tpl)}>{tr("Точки")}</button>
            <button className="x" title={tr("Удалить шаблон")} onClick={() => update(list.filter((x) => x.id !== tpl.id))}><Icon name="close" size={14} /></button>
          </div>
        </div>
      ))}
      {!list.length && <p className="hint">{tr("Своих шаблонов пока нет.")}</p>}
      <div className="chips">
        <button onClick={() => setEdit({ id: Date.now().toString(36), name: tr("Новый шаблон"), lines: [{ tags: { highway: "secondary", lanes: "2", maxspeed: "60" }, pts: [[-30, 0], [30, 0]] }] })}><Icon name="plus" size={15} />{tr("Новый шаблон по точкам")}</button>
      </div>
      <GraphSummary />
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
      <div className="sub">{tr("x - на восток, y - на север, метры от точки вставки")}</div>
      <TemplateSketch tpl={t} size={140} mark />
      {t.lines.map((l, i) => (
        <div key={i} className="tpl-line">
          <div className="chips">
            <b>{tr("Линия")}{" "}{i + 1}</b>
            <select value={kindOf(l.tags)} onChange={(e) => { const [k, v] = e.target.value.split("="); setLine(i, (x) => { if (k === "railway") x.tags = { railway: v }; else { x.tags = { ...x.tags, highway: v }; delete x.tags.railway; } }); }}>
              {kinds.map(([v, ru]) => <option key={v} value={v}>{ru}</option>)}
            </select>
            <label className="hint"><input type="checkbox" checked={!!l.closed} onChange={(e) => setLine(i, (x) => { x.closed = e.target.checked; })} /> {" "}{tr("Замкнутая")}</label>
            <button className="x" title={tr("Удалить линию")} onClick={() => setT({ ...t, lines: t.lines.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
          </div>
          <table className="pts">
            <tbody>
              {l.pts.map((p, j) => (
                <tr key={j}>
                  <td>{j + 1}</td>
                  {[0, 1].map((c) => <td key={c}><input type="number" step="1" value={p[c]} onChange={(e) => setLine(i, (x) => { x.pts[j][c] = Number(e.target.value) || 0; })} /></td>)}
                  <td><button className="x" title={tr("Удалить точку")} disabled={l.pts.length <= 2} onClick={() => setLine(i, (x) => { x.pts.splice(j, 1); })}><Icon name="close" size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="chips"><button onClick={() => setLine(i, (x) => { const last = x.pts[x.pts.length - 1]; x.pts.push([last[0] + 20, last[1]]); })}><Icon name="plus" size={14} />{tr("Точка")}</button></div>
        </div>
      ))}
      <div className="chips">
        <button onClick={() => setT({ ...t, lines: [...t.lines, { tags: { highway: "residential" }, pts: [[0, 0], [0, 30]] }] })}><Icon name="plus" size={14} />{tr("Линия")}</button>
      </div>
      <p className="hint">{tr("Одинаковые точки разных линий при вставке становятся общим узлом, так линии связаны между собой.")}</p>
      <div className="chips">
        <button className="primary" disabled={!t.lines.length} onClick={() => onSave(t)}>{tr("Сохранить")}</button>
        <button onClick={onCancel}>{tr("Отмена")}</button>
      </div>
    </div>
  );
}
