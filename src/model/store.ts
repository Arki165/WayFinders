// Состояние редактора и все операции правки с отменой (Ctrl+Z)
import { create } from "zustand";
import type { OsmData, OsmNode, OsmRelation, OsmWay, Tags } from "../osm/types";
import { validate, type GraphError, type ValidationResult } from "./validate";
import { loadNorms, saveNorms, type Norms } from "./calc";
import { distM, makeProjection, project } from "./geo";
import { buildingAt, buildingIndex, buildingsOnSegment, mayCrossBuildings, wayThroughBuilding } from "./buildings";
import { isDrivable, lanesOf, roadClass, type Arm } from "./roads";
import { roadWidth } from "./lanes";
import { copyRouteMembership } from "./routes";
import type { CustomTemplate } from "./templates";
import { tr } from "../i18n";

// ways - несколько дорог (Shift+клик) или участок между двумя узлами (section)
export type Section = { from: number; to: number; nodes: number[]; length: number };
export type Selection = { kind: "way"; id: number } | { kind: "node"; id: number } | { kind: "ways"; ids: number[]; section?: Section } | null;
export type Tool = "select" | "draw" | "node" | "join" | "unjoin" | "signal" | "split" | "delete";

// Команда правки: умеет сделать и отменить себя
interface Command {
  label: string;
  time: Date;
  undo: () => void;
  redo: () => void;
}

interface EditorState {
  data: OsmData | null;
  // Исходник для сравнения «до / после». Полную копию графа не держим (на большом городе это
  // удваивало память, и окно падало): запоминаем только исходный вид тех дорог, узлов и маршрутов,
  // которые правили. Сам исходный граф собирает getOriginal(), когда он нужен.
  original: OrigLog | null;
  fileName: string;
  filePath: string | null;
  selection: Selection;
  tool: Tool;
  version: number; // растет после каждой правки, по нему перерисовывается интерфейс
  past: Command[];
  future: Command[];
  saved: Command | null; // последняя правка на момент сохранения: по ней видно, есть ли несохраненное
  log: { label: string; time: Date }[];
  check: ValidationResult | null;
  checkStale: boolean; // большой граф: проверка отложена, check пока от прошлой правки
  ignored: Set<string>;
  norms: Norms;
  analysis: number[]; // дороги, добавленные в расчет
  // куда перелететь карте: точка с масштабом или рамка [запад, юг, восток, север]
  focus: { lat: number; lon: number; zoom?: number; bounds?: [number, number, number, number]; t: number } | null;
  highlight: number[];
  message: { text: string; t: number } | null;

  load: (data: OsmData, fileName: string, filePath: string | null) => void;
  select: (s: Selection) => void;
  setTool: (t: Tool) => void;
  run: (label: string, ways: number[], nodes: number[], mutate: () => void) => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  recheck: (now?: boolean) => void;
  toast: (text: string) => void;
  flyTo: (lat: number, lon: number, zoom?: number) => void;
  fitTo: (bounds: [number, number, number, number]) => void;
  setNorms: (n: Norms) => void;
  setAnalysis: (ids: number[]) => void;
  ignore: (key: string) => void;
  setHighlight: (ids: number[]) => void;
  bump: () => void;
}

// Снимок дорог и узлов до и после правки: так отмена работает для любой операции
type WaySnap = Map<number, OsmWay | null>;
type NodeSnap = Map<number, OsmNode | null>;
const snapWays = (d: OsmData, ids: number[]): WaySnap => new Map(ids.map((id) => { const w = d.ways.get(id); return [id, w ? { ...w, nodeIds: [...w.nodeIds], tags: { ...w.tags } } : null]; }));
const snapNodes = (d: OsmData, ids: number[]): NodeSnap => new Map(ids.map((id) => { const n = d.nodes.get(id); return [id, n ? { ...n, tags: { ...n.tags } } : null]; }));
function restore(d: OsmData, ws: WaySnap, ns: NodeSnap) {
  for (const [id, n] of ns) n ? d.nodes.set(id, { ...n, tags: { ...n.tags } }) : d.nodes.delete(id);
  for (const [id, w] of ws) w ? d.ways.set(id, { ...w, nodeIds: [...w.nodeIds], tags: { ...w.tags } }) : d.ways.delete(id);
}

let nextId = -1;
export const BIG_NODES = 60000, CHECK_DELAY = 500;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
export const newId = () => nextId--;

// Исходный вид измененных элементов: значение до первой правки, null - элемента не было
export interface OrigLog {
  nodes: Map<number, OsmNode | null>;
  ways: Map<number, OsmWay | null>;
  relations: Map<number, OsmRelation | null>;
  loadedAt: number; // когда открыт файл: по нему карта один раз показывает весь граф
}
const newLog = (): OrigLog => ({ nodes: new Map(), ways: new Map(), relations: new Map(), loadedAt: Date.now() });

// Был ли элемент в исходном файле (до всех правок)
export function inOriginal(kind: "nodes" | "ways" | "relations", id: number): boolean {
  const st = useEditor.getState(), log = st.original, d = st.data;
  if (log?.[kind].has(id)) return log[kind].get(id) !== null;
  return !!d?.[kind].has(id);
}

// Исходный граф: текущий, в котором измененные элементы заменены их исходным видом.
// Не копирует объекты (только списки), поэтому быстрый и почти не занимает памяти. Только для чтения!
export function getOriginal(): OsmData | null {
  const { data: d, original: log } = useEditor.getState();
  if (!d || !log) return null;
  const put = <T,>(cur: Map<number, T>, changes: Map<number, T | null>) => {
    if (!changes.size) return cur;
    const m = new Map(cur);
    for (const [id, v] of changes) { if (v) m.set(id, v); else m.delete(id); }
    return m;
  };
  return { ...d, nodes: put(d.nodes, log.nodes), ways: put(d.ways, log.ways), relations: put(d.relations, log.relations) };
}

export const useEditor = create<EditorState>((set, get) => ({
  data: null,
  original: null,
  fileName: "",
  filePath: null,
  selection: null,
  tool: "select",
  version: 0,
  past: [],
  future: [],
  saved: null,
  log: [],
  check: null,
  checkStale: false,
  ignored: new Set(),
  norms: loadNorms(),
  analysis: [],
  focus: null,
  highlight: [],
  message: null,

  load: (data, fileName, filePath) => {
    nextId = -1;
    set({ data, original: newLog(), fileName, filePath, selection: null, past: [], future: [], saved: null, log: [], ignored: new Set(), analysis: [], highlight: [], version: get().version + 1 });
    get().recheck(true);
  },
  select: (selection) => set({ selection }),
  setTool: (tool) => set({ tool }),

  // Любая правка проходит через run: сохраняем затронутые дороги и узлы до и после
  run: (label, wayIds, nodeIds, mutate) => {
    const d = get().data;
    if (!d) return;
    const beforeW = snapWays(d, wayIds), beforeN = snapNodes(d, nodeIds);
    const newWays = new Set(d.ways.keys()), newNodes = new Set(d.nodes.keys());
    mutate();
    // новые элементы, созданные внутри mutate, тоже попадают в снимок
    const addedW = [...d.ways.keys()].filter((id) => !newWays.has(id));
    const addedN = [...d.nodes.keys()].filter((id) => !newNodes.has(id));
    for (const id of addedW) beforeW.set(id, null);
    for (const id of addedN) beforeN.set(id, null);
    // исходный вид: запоминаем только при первой правке элемента
    const log = get().original;
    if (log) {
      for (const [id, w] of beforeW) if (!log.ways.has(id)) log.ways.set(id, w);
      for (const [id, n] of beforeN) if (!log.nodes.has(id)) log.nodes.set(id, n);
    }
    const afterW = snapWays(d, [...beforeW.keys()]), afterN = snapNodes(d, [...beforeN.keys()]);
    const cmd: Command = { label, time: new Date(), undo: () => restore(d, beforeW, beforeN), redo: () => restore(d, afterW, afterN) };
    set({ past: [...get().past, cmd], future: [], log: [{ label, time: cmd.time }, ...get().log] });
    get().recheck();
  },
  undo: () => {
    const past = [...get().past];
    const cmd = past.pop();
    if (!cmd) return get().toast(tr("Нечего отменять"));
    cmd.undo();
    set({ past, future: [cmd, ...get().future], log: [{ label: tr("Отмена: ") + cmd.label, time: new Date() }, ...get().log] });
    fixSelection(get, set);
    get().recheck();
    get().toast(tr("Отменено: ") + cmd.label);
  },
  redo: () => {
    const [cmd, ...rest] = get().future;
    if (!cmd) return get().toast(tr("Нечего повторять"));
    cmd.redo();
    set({ past: [...get().past, cmd], future: rest, log: [{ label: tr("Повтор: ") + cmd.label, time: new Date() }, ...get().log] });
    fixSelection(get, set);
    get().recheck();
  },
  markSaved: () => set({ saved: get().past[get().past.length - 1] ?? null }),
  // Проверка графа после правки. На большом городе (больше BIG_NODES узлов) она занимает около секунды,
  // поэтому там правка применяется сразу, а проверка идет через CHECK_DELAY мс после последней правки.
  // now - проверить немедленно (открытие файла, сохранение, массовое исправление)
  recheck: (now) => {
    const d = get().data;
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
    if (!d || now || d.nodes.size <= BIG_NODES || !get().check) {
      set({ check: d ? validate(d, get().ignored) : null, checkStale: false, version: get().version + 1 });
      return;
    }
    set({ checkStale: true, version: get().version + 1 });
    checkTimer = setTimeout(() => {
      checkTimer = null;
      const cur = get().data;
      if (cur) set({ check: validate(cur, get().ignored), checkStale: false, version: get().version + 1 });
    }, CHECK_DELAY);
  },
  toast: (text) => set({ message: { text, t: Date.now() } }),
  flyTo: (lat, lon, zoom) => set({ focus: { lat, lon, zoom, t: Date.now() } }),
  fitTo: (b) => set({ focus: { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2, bounds: b, t: Date.now() } }),
  setNorms: (norms) => { saveNorms(norms); set({ norms, version: get().version + 1 }); },
  setAnalysis: (analysis) => set({ analysis, version: get().version + 1 }),
  ignore: (key) => { const s = new Set(get().ignored); s.add(key); set({ ignored: s }); get().recheck(); },
  // подсветка не меняет данные, поэтому номер версии не трогаем: карта перекрашивает только цвет
  setHighlight: (highlight) => set({ highlight }),
  bump: () => set({ version: get().version + 1 }),
}));

// Есть ли правки, которых нет в файле на диске
export function isDirty(): boolean {
  const { data, past, saved } = useEditor.getState();
  return !!data && (past[past.length - 1] ?? null) !== saved;
}
// Можно ли заменить открытый граф другим: при несохраненных правках спрашиваем
export function okToReplace(): boolean {
  return !isDirty() || confirm(tr("Есть несохраненные правки. Открыть другой граф без сохранения?"));
}

function fixSelection(get: () => EditorState, set: (p: Partial<EditorState>) => void) {
  const { selection: s, data } = get();
  if (!s || !data) return;
  if ((s.kind === "way" && !data.ways.has(s.id)) || (s.kind === "node" && !data.nodes.has(s.id))) set({ selection: null });
  if (s.kind === "ways") {
    const ids = s.ids.filter((id) => data.ways.has(id));
    if (!ids.length) set({ selection: null });
    else if (ids.length === 1) set({ selection: { kind: "way", id: ids[0] } });
    else if (ids.length !== s.ids.length || s.section) set({ selection: { kind: "ways", ids } });
  }
}

// ---------- операции правки ----------
const ed = () => useEditor.getState();
const waysWithNode = (d: OsmData, id: number) => [...d.ways.values()].filter((w) => w.nodeIds.includes(id)).map((w) => w.id);

export function setWayTags(wayId: number, tags: Tags, label: string) {
  const d = ed().data!;
  ed().run(label, [wayId], [], () => { const w = d.ways.get(wayId); if (w) w.tags = { ...tags }; });
}

// Замеры N и T факт сразу по многим дорогам (загрузка результатов SUMO), одной правкой для отмены
export function setMeasures(list: { id: number; N: number; T: number }[], label: string) {
  const d = ed().data!;
  ed().run(label, list.map((m) => m.id), [], () => {
    for (const m of list) {
      const w = d.ways.get(m.id);
      if (w) w.tags = { ...w.tags, "wayfinders:volume": String(m.N), "wayfinders:travel_time": String(m.T) };
    }
  });
}

export function setNodeTags(nodeId: number, tags: Tags, label: string) {
  const d = ed().data!;
  ed().run(label, [], [nodeId], () => { const n = d.nodes.get(nodeId); if (n) n.tags = { ...tags }; });
}

// ---------- дороги и здания ----------
export const THROUGH_BUILDING = "Дорога не может проходить сквозь здание. Обойдите его или сделайте мост (панель дороги: «Мост»)";

// Проверка новой линии: точки не внутри здания и отрезки не сквозь здание. Мосты, тоннели и сами здания не проверяются.
export function lineHitsBuilding(points: { lat: number; lon: number }[], tags: Tags): boolean {
  const d = ed().data;
  if (!d || tags.building || mayCrossBuildings({ id: 0, nodeIds: [], tags, attrs: {} }) || (tags.railway === "tram" && tags.embedded === "yes")) return false;
  const ix = buildingIndex(d);
  return points.some((p, i) => buildingAt(ix, p) !== null || (i > 0 && buildingsOnSegment(ix, points[i - 1], p).length > 0));
}

// Пройдет ли дорога сквозь здание, если ее узел nodeId окажется в точке to
function nodeHitsBuilding(d: OsmData, nodeId: number, to: [number, number]): boolean {
  const ix = buildingIndex(d);
  return [...d.ways.values()].some((w) => {
    const i = w.nodeIds.indexOf(nodeId);
    if (i < 0 || !isDrivable(w) || mayCrossBuildings(w)) return false;
    const at = { lat: to[0], lon: to[1] };
    if (buildingAt(ix, at)) return true;
    return [w.nodeIds[i - 1], w.nodeIds[i + 1]].some((id) => { const m = id !== undefined ? d.nodes.get(id) : undefined; return !!m && buildingsOnSegment(ix, m, at).length > 0; });
  });
}

// Магнит при перетаскивании: узел дороги отпустили на другом узле или на линии другой дороги.
// Узел уже стоит в точке прилипания. Перенос и соединение записываются одной правкой: Ctrl+Z вернет узел на старое место.
export function dropNodeOn(nodeId: number, from: [number, number], target: { id: number | null; onWay?: number }) {
  const d = ed().data!;
  const n = d.nodes.get(nodeId);
  if (!n) return;
  const to: [number, number] = [n.lat, n.lon];
  n.lat = from[0]; n.lon = from[1];
  if (nodeHitsBuilding(d, nodeId, to)) { ed().bump(); return ed().toast(tr(THROUGH_BUILDING)); }
  if (target.id !== null && d.nodes.has(target.id)) {
    const keep = target.id;
    ed().run(tr("Узел перенесен и соединен с узлом"), [...new Set([...waysWithNode(d, nodeId), ...waysWithNode(d, keep)])], [nodeId, keep], () => mergeInto(d, keep, nodeId));
    ed().select({ kind: "node", id: keep });
    return ed().toast(tr("Узлы соединены, дороги теперь связаны"));
  }
  const w = target.onWay !== undefined ? d.ways.get(target.onWay) : undefined;
  const seg = w ? nearestSegment(d, w, to[0], to[1]) : null;
  if (!w || !seg || seg.idx < 0) { ed().run(tr("Перенос узла"), [], [nodeId], () => { n.lat = to[0]; n.lon = to[1]; }); return; }
  const [plat, plon] = seg.pr.toLatLon(seg.q[0], seg.q[1]);
  ed().run(tr("Узел перенесен и соединен с дорогой"), [...new Set([...waysWithNode(d, nodeId), w.id])], [nodeId], () => {
    n.lat = plat; n.lon = plon;
    w.nodeIds.splice(seg.idx, 0, nodeId);
  });
  ed().toast(tr("Узел присоединен к дороге"));
}

export function moveNodeDone(nodeId: number, from: [number, number]) {
  // узел уже передвинут во время перетаскивания, записываем команду в историю
  const d = ed().data!;
  const n = d.nodes.get(nodeId)!;
  const to: [number, number] = [n.lat, n.lon];
  n.lat = from[0]; n.lon = from[1];
  // узел дороги нельзя затащить так, чтобы дорога прошла сквозь здание: узел возвращается на место
  if (nodeHitsBuilding(d, nodeId, to)) { ed().bump(); return ed().toast(tr(THROUGH_BUILDING)); }
  // угол здания: здание не должно наехать на дорогу
  n.lat = to[0]; n.lon = to[1];
  const onRoad = buildingsOf(d, [nodeId]).some((b) => roadThroughBuilding(d, b));
  n.lat = from[0]; n.lon = from[1];
  if (onRoad) { ed().bump(); return ed().toast(tr(BUILDING_ON_ROAD)); }
  const blds = buildingsOf(d, [nodeId]);
  if (!blds.length) { ed().run(tr("Перенос узла"), [], [nodeId], () => { n.lat = to[0]; n.lon = to[1]; }); return; }
  // угол здания: после переноса убираем углы, которые легли на прямую стену или на соседний угол
  let removed: number[] = [];
  ed().run(tr("Угол здания"), blds.map((b) => b.id), [...new Set(blds.flatMap((b) => b.nodeIds))], () => {
    n.lat = to[0]; n.lon = to[1];
    for (const b of blds) removed.push(...cleanBuilding(d, b));
  });
  if (removed.length) ed().toast(removed.includes(nodeId) ? tr("Угол лег на прямую стену и убран") : tr("Лишние углы на прямой стене убраны"));
  removed = [];
}

// ---------- лишние углы здания ----------
const CORNER_TOL_M = 0.5; // угол ближе полуметра к прямой между соседями - лишний

// Углы здания, без которых форма не меняется: лежат на прямой между соседями или совпадают с соседом.
// Углы, общие с другой линией (соседний дом, забор) или с тегами (вход), не трогаем.
export function extraCorners(d: OsmData, b: OsmWay): number[] {
  const ring = b.nodeIds.slice(0, -1);
  const lat0 = d.nodes.get(ring[0])?.lat ?? 0;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320, ky = 111320;
  const xy = (id: number): [number, number] => { const p = d.nodes.get(id)!; return [p.lon * kx, p.lat * ky]; };
  const used = new Set<number>();
  for (const w of d.ways.values()) if (w.id !== b.id) for (const id of w.nodeIds) used.add(id);
  const out: number[] = [];
  const left = [...ring];
  // убираем по одному и проверяем заново: после удаления соседи меняются
  for (let changed = true; changed && left.length > 3; ) {
    changed = false;
    for (let i = 0; i < left.length && left.length > 3; i++) {
      const id = left[i], node = d.nodes.get(id);
      if (!node || used.has(id) || Object.keys(node.tags).length) continue;
      const a = xy(left[(i - 1 + left.length) % left.length]), p = xy(id), c = xy(left[(i + 1) % left.length]);
      const vx = c[0] - a[0], vy = c[1] - a[1], L = Math.hypot(vx, vy);
      const toLine = L ? Math.abs((p[0] - a[0]) * vy - (p[1] - a[1]) * vx) / L : 0;
      const t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (L * L) : 0;
      const nearNeighbor = Math.hypot(p[0] - a[0], p[1] - a[1]) < CORNER_TOL_M || Math.hypot(p[0] - c[0], p[1] - c[1]) < CORNER_TOL_M;
      // на прямой и между соседями (не «шип» назад), или вплотную к соседнему углу
      if (nearNeighbor || (toLine < CORNER_TOL_M && t > 0 && t < 1)) { out.push(id); left.splice(i, 1); changed = true; i--; }
    }
  }
  return out;
}

// Убрать лишние углы прямо в данных (вызывать внутри run). Возвращает убранные узлы
function cleanBuilding(d: OsmData, b: OsmWay): number[] {
  const extra = extraCorners(d, b);
  if (!extra.length) return [];
  const drop = new Set(extra);
  const ring = b.nodeIds.slice(0, -1).filter((id) => !drop.has(id));
  b.nodeIds = [...ring, ring[0]];
  for (const id of extra) d.nodes.delete(id);
  return extra;
}

// Кнопка «Убрать лишние углы» в панели здания
export function cleanBuildingCorners(wayId: number) {
  const d = ed().data!;
  const b = d.ways.get(wayId);
  if (!b) return;
  const n = extraCorners(d, b).length;
  if (!n) return ed().toast(tr("Лишних углов нет"));
  ed().run(tr("Лишние углы здания убраны"), [wayId], [...b.nodeIds], () => { cleanBuilding(d, b); });
  ed().toast(tr("Убрано углов: {0}", n));
}

// ---------- маршруты (отношения OSM) ----------
// Правка одного отношения с отменой: снимок отношения до и после, как у дорог в run
const snapRel = (d: OsmData, id: number): OsmRelation | null => { const r = d.relations.get(id); return r ? { ...r, members: r.members.map((m) => ({ ...m })), tags: { ...r.tags } } : null; };
function putRel(d: OsmData, id: number, r: OsmRelation | null) {
  if (r) d.relations.set(id, { ...r, members: r.members.map((m) => ({ ...m })), tags: { ...r.tags } }); else d.relations.delete(id);
}
export function runRelation(label: string, relId: number, mutate: (d: OsmData) => void) {
  const st = ed(), d = st.data;
  if (!d) return;
  const before = snapRel(d, relId);
  if (st.original && !st.original.relations.has(relId)) st.original.relations.set(relId, before);
  mutate(d);
  const after = snapRel(d, relId);
  const cmd = { label, time: new Date(), undo: () => putRel(d, relId, before), redo: () => putRel(d, relId, after) };
  useEditor.setState({ past: [...st.past, cmd], future: [], log: [{ label, time: cmd.time }, ...st.log] });
  ed().recheck();
}

// ---------- редактор зданий ----------
export const BUILDING_ON_ROAD = "Здание нельзя поставить на дорогу: сначала уберите или перенесите дорогу, либо сделайте ее мостом или аркой";

const isBuilding = (w: OsmWay) => !!w.tags.building && w.tags.building !== "no";
// здания, у которых есть хотя бы один из узлов ids
function buildingsOf(d: OsmData, ids: number[]): OsmWay[] {
  const set = new Set(ids);
  return [...d.ways.values()].filter((w) => isBuilding(w) && w.nodeIds.some((id) => set.has(id)));
}

// Проходит ли сквозь здание b какая-нибудь дорога (мосты, тоннели и арки можно)
function roadThroughBuilding(d: OsmData, b: OsmWay): boolean {
  const ix = buildingIndex({ ...d, ways: new Map([[b.id, b]]) });
  // сначала грубо: дороги, у которых хоть один узел рядом с прямоугольником здания
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const id of b.nodeIds) { const p = d.nodes.get(id); if (p) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); } }
  const pad = 0.003; // около 300 м: длинный отрезок дороги может пересечь дом, хотя его концы далеко
  for (const r of d.ways.values()) {
    if (!isDrivable(r)) continue;
    const near = r.nodeIds.some((id) => { const p = d.nodes.get(id); return !!p && p.lat > s - pad && p.lat < n + pad && p.lon > w - pad && p.lon < e + pad; });
    if (!near || mayCrossBuildings(r)) continue;
    if (wayThroughBuilding(d, ix, r)) return true;
    // стена ближе половины ширины дороги: дом стоит на проезжей части, хотя ось дороги снаружи
    if (wallOnRoad(d, b, r)) return true;
  }
  return false;
}

// Расстояние от стен здания b до оси дороги r меньше половины ширины проезжей части
function wallOnRoad(d: OsmData, b: OsmWay, r: OsmWay): boolean {
  const lat0 = d.nodes.get(b.nodeIds[0])?.lat ?? 0;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320, ky = 111320; // градусы в метры
  const xy = (id: number): [number, number] | null => { const p = d.nodes.get(id); return p ? [p.lon * kx, p.lat * ky] : null; };
  const half = roadWidth(r) / 2 - 0.3; // 30 см запаса: тротуар у стены - это нормально
  // расстояние от точки p до отрезка a-c
  const toSeg = (p: [number, number], a: [number, number], c: [number, number]) => {
    const vx = c[0] - a[0], vy = c[1] - a[1], L2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2));
    return Math.hypot(a[0] + vx * t - p[0], a[1] + vy * t - p[1]);
  };
  for (let i = 1; i < b.nodeIds.length; i++) {
    const a = xy(b.nodeIds[i - 1]), c = xy(b.nodeIds[i]);
    if (!a || !c) continue;
    for (let j = 1; j < r.nodeIds.length; j++) {
      const p = xy(r.nodeIds[j - 1]), q = xy(r.nodeIds[j]);
      if (!p || !q) continue;
      // отрезки не пересекаются (это ловит wayThroughBuilding), значит ближе всего концы одного к другому
      if (Math.min(toSeg(a, p, q), toSeg(c, p, q), toSeg(p, a, c), toSeg(q, a, c)) < half) return true;
    }
  }
  return false;
}

// Перенос здания целиком: узлы уже сдвинуты мышью, from - где они были. Записываем в историю или возвращаем
export function moveBuildingDone(wayId: number, from: Map<number, [number, number]>) {
  const d = ed().data!;
  const b = d.ways.get(wayId);
  if (!b) return;
  const to = new Map([...from.keys()].map((id) => { const p = d.nodes.get(id)!; return [id, [p.lat, p.lon] as [number, number]]; }));
  if (roadThroughBuilding(d, b)) {
    for (const [id, [lat, lon]] of from) { const p = d.nodes.get(id)!; p.lat = lat; p.lon = lon; }
    ed().bump();
    return ed().toast(tr(BUILDING_ON_ROAD));
  }
  for (const [id, [lat, lon]] of from) { const p = d.nodes.get(id)!; p.lat = lat; p.lon = lon; }
  ed().run(tr("Перенос здания"), [], [...from.keys()], () => {
    for (const [id, [lat, lon]] of to) { const p = d.nodes.get(id)!; p.lat = lat; p.lon = lon; }
  });
}

// Новый угол здания между углами index-1 и index (точка на стене). Возвращает id нового узла
// Новый угол, вытянутый из стены: пока мышь тянет, угол временный (без истории),
// а когда отпустили - записываем одним шагом. Если угол остался на прямой стене, его просто нет.
export function addBuildingCorner(wayId: number, index: number, lat: number, lon: number) {
  const d = ed().data!;
  const b = d.ways.get(wayId);
  if (!b || index < 1 || index >= b.nodeIds.length) return;
  const id = newId();
  // проверка дороги: временно ставим угол и смотрим, не наехало ли здание на дорогу
  d.nodes.set(id, { id, lat, lon, tags: {}, attrs: {} });
  b.nodeIds.splice(index, 0, id);
  const extra = extraCorners(d, b).includes(id);
  const onRoad = !extra && roadThroughBuilding(d, b);
  b.nodeIds.splice(index, 1);
  d.nodes.delete(id);
  if (extra) { ed().bump(); return; } // стену вернули на место - ничего не меняем
  if (onRoad) { ed().bump(); return ed().toast(tr(BUILDING_ON_ROAD)); }
  ed().run(tr("Новый угол здания"), [wayId], [...b.nodeIds], () => {
    d.nodes.set(id, { id, lat, lon, tags: {}, attrs: {} });
    b.nodeIds.splice(index, 0, id);
    cleanBuilding(d, b);
  });
}

// Убрать угол здания (Shift+клик по углу). Меньше трех углов не бывает
export function removeBuildingCorner(wayId: number, nodeId: number) {
  const d = ed().data!;
  const b = d.ways.get(wayId);
  if (!b) return;
  const ring = b.nodeIds.slice(0, -1); // контур замкнут: последний узел = первый
  if (ring.length <= 3) return ed().toast(tr("У здания должно остаться хотя бы три угла"));
  const left = ring.filter((id) => id !== nodeId);
  // узел нужен еще где-то (у соседнего дома или дороги) - только убираем из этого здания
  const shared = [...d.ways.values()].some((w) => w.id !== wayId && w.nodeIds.includes(nodeId));
  ed().run(tr("Угол здания убран"), [wayId], [nodeId], () => {
    b.nodeIds = [...left, left[0]];
    if (!shared) d.nodes.delete(nodeId);
  });
}

// Точка новой линии: id - существующий узел, onWay - точка прилипла к дороге (там появится общий узел)
export type DrawPoint = { id: number | null; lat: number; lon: number; onWay?: number };

// Дороги, которые идут по тому же отрезку дороги w, что и точка (lat, lon): в них тоже вставляем узел
function waysOnSegment(d: OsmData, w: OsmWay, lat: number, lon: number): OsmWay[] {
  const seg = nearestSegment(d, w, lat, lon);
  if (seg.idx < 0) return [];
  const a = w.nodeIds[seg.idx - 1], b = w.nodeIds[seg.idx];
  return [...d.ways.values()].filter((x) => x.nodeIds.some((id, i) => i > 0 && ((x.nodeIds[i - 1] === a && id === b) || (x.nodeIds[i - 1] === b && id === a))));
}

export function addWay(points: DrawPoint[], tags: Tags) {
  const d = ed().data!;
  if (lineHitsBuilding(points, tags)) { ed().toast(tr(THROUGH_BUILDING)); return false; }
  let wid = 0;
  const track = !!tags.railway;
  // дороги, к которым прилипли точки: они меняются (в них новый узел), нужны в снимке для отмены
  const glued: number[] = [];
  for (const p of points) {
    const w = p.onWay !== undefined ? d.ways.get(p.onWay) : undefined;
    if (w) for (const x of waysOnSegment(d, w, p.lat, p.lon)) glued.push(x.id);
  }
  // рельсы могут получить переезды на дорогах, эти дороги нужны в снимке для отмены
  ed().run(track ? tr("Новые пути") : tags.building ? tr("Новое здание") : tr("Новая дорога"), [...new Set([...(track ? roadsNear(d, points) : []), ...glued])], [], () => {
    const ids = points.map((p, i) => {
      if (p.id !== null) return p.id;
      // точка на дороге: ставим узел точно на линию дороги и вставляем его во все дороги этого отрезка
      const w = p.onWay !== undefined ? d.ways.get(p.onWay) : undefined;
      if (w) {
        const seg = nearestSegment(d, w, p.lat, p.lon);
        if (seg.idx > 0) {
          const [lat, lon] = seg.pr.toLatLon(seg.q[0], seg.q[1]);
          const a = w.nodeIds[seg.idx - 1], b = w.nodeIds[seg.idx];
          // почти в узел дороги - берем этот узел
          for (const id of [a, b]) { const m = d.nodes.get(id)!; if (distM(m.lat, m.lon, lat, lon) < 1) return id; }
          const id = newId();
          d.nodes.set(id, { id, lat, lon, tags: {}, attrs: {} });
          for (const x of d.ways.values())
            for (let k = x.nodeIds.length - 1; k > 0; k--) {
              const q = x.nodeIds[k - 1], c = x.nodeIds[k];
              if ((q === a && c === b) || (q === b && c === a)) x.nodeIds.splice(k, 0, id);
            }
          return id;
        }
      }
      // рельсы сами стыкуются с соседними путями того же вида, если конец ближе 15 м
      if (track && (i === 0 || i === points.length - 1)) {
        const near = nearestNode(d, p.lat, p.lon, DOCK_M, (w) => w.tags.railway === tags.railway);
        if (near !== null) return near;
      }
      const id = newId();
      d.nodes.set(id, { id, lat: p.lat, lon: p.lon, tags: {}, attrs: {} });
      return id;
    });
    // здание - замкнутый контур: последняя точка совпадает с первой
    if (tags.building && ids.length >= 3) ids.push(ids[0]);
    wid = newId();
    d.ways.set(wid, { id: wid, nodeIds: ids, tags: { ...tags }, attrs: {} });
    if (track) addLevelCrossings(d, d.ways.get(wid)!);
  });
  ed().select({ kind: "way", id: wid });
  return true;
}

export function deleteWay(wayId: number) {
  const d = ed().data!;
  ed().run(tr("Удаление дороги"), [wayId], [], () => { d.ways.delete(wayId); });
  ed().select(null);
}

export function deleteNode(nodeId: number) {
  const d = ed().data!;
  const ws = waysWithNode(d, nodeId);
  ed().run(tr("Удаление узла"), ws, [nodeId], () => {
    for (const id of ws) {
      const w = d.ways.get(id)!;
      // без узла соседи могут оказаться рядом одинаковыми (A, узел, A): повтор подряд - ребро нулевой длины, убираем
      w.nodeIds = w.nodeIds.filter((x) => x !== nodeId).filter((x, i, a) => i === 0 || x !== a[i - 1]);
      if (w.nodeIds.length < 2) d.ways.delete(id);
    }
    d.nodes.delete(nodeId);
  });
  ed().select(null);
}

export function reverseWay(wayId: number) {
  const d = ed().data!;
  ed().run(tr("Разворот направления"), [wayId], [], () => { const w = d.ways.get(wayId)!; w.nodeIds.reverse(); });
}

export function splitWay(wayId: number, nodeId: number) {
  const d = ed().data!;
  const w = d.ways.get(wayId)!;
  const i = w.nodeIds.indexOf(nodeId);
  if (i <= 0 || i >= w.nodeIds.length - 1) return ed().toast(tr("Это конец дороги, разрезать нельзя"));
  ed().run(tr("Разрезание дороги"), [wayId], [], () => {
    const id = newId();
    d.ways.set(id, { id, nodeIds: w.nodeIds.slice(i), tags: { ...w.tags }, attrs: {} });
    w.nodeIds = w.nodeIds.slice(0, i + 1);
    // вторая половина остается в тех же маршрутах автобусов и трамваев
    copyRouteMembership(d, wayId, id);
  });
  ed().toast(tr("Дорога разрезана на две"));
}

// Склеить узел drop с узлом keep (так чинятся разорванные перекрестки)
function mergeInto(d: OsmData, keep: number, drop: number) {
  for (const w of [...d.ways.values()]) {
    if (!w.nodeIds.includes(drop)) continue;
    w.nodeIds = w.nodeIds.map((x) => (x === drop ? keep : x)).filter((x, i, a) => i === 0 || x !== a[i - 1]);
    if (w.nodeIds.length < 2) d.ways.delete(w.id);
  }
  const dn = d.nodes.get(drop), kn = d.nodes.get(keep);
  if (dn && kn) kn.tags = { ...dn.tags, ...kn.tags };
  d.nodes.delete(drop);
}

// Ближайший к точке отрезок дороги: номер второго узла отрезка и точка на нем (в метрах)
function nearestSegment(d: OsmData, w: OsmWay, lat: number, lon: number) {
  const pr = makeProjection(lat, lon);
  const xy = (id: number): [number, number] => { const n = d.nodes.get(id)!; return pr.toXY(n.lat, n.lon); };
  let best = { idx: -1, dist: Infinity, q: [0, 0] as [number, number], t: 0 };
  for (let i = 1; i < w.nodeIds.length; i++) {
    const { q, t, d: dist } = project([0, 0], xy(w.nodeIds[i - 1]), xy(w.nodeIds[i]));
    if (dist < best.dist) best = { idx: i, dist, q, t };
  }
  return { ...best, pr };
}

// Добавить узел на дорогу в месте клика. Узел встает точно на линию дороги.
export function insertNode(wayId: number, lat: number, lon: number) {
  const d = ed().data!;
  const w = d.ways.get(wayId);
  if (!w) return;
  const seg = nearestSegment(d, w, lat, lon);
  if (seg.idx < 0) return;
  const [nlat, nlon] = seg.pr.toLatLon(seg.q[0], seg.q[1]);
  // если клик почти в существующий узел, новый не нужен
  for (const id of [w.nodeIds[seg.idx - 1], w.nodeIds[seg.idx]]) {
    const n = d.nodes.get(id)!;
    if (distM(n.lat, n.lon, nlat, nlon) < 1) { ed().select({ kind: "node", id }); return ed().toast(tr("Здесь уже есть узел")); }
  }
  // узел добавляется во все дороги, которые идут по этому же отрезку
  const a = w.nodeIds[seg.idx - 1], b = w.nodeIds[seg.idx];
  const sameSeg = [...d.ways.values()].filter((x) => x.nodeIds.some((id, i) => i > 0 && ((x.nodeIds[i - 1] === a && id === b) || (x.nodeIds[i - 1] === b && id === a))));
  let nid = 0;
  ed().run(tr("Новый узел на дороге"), sameSeg.map((x) => x.id), [], () => {
    nid = newId();
    d.nodes.set(nid, { id: nid, lat: nlat, lon: nlon, tags: {}, attrs: {} });
    for (const x of sameSeg) {
      for (let i = x.nodeIds.length - 1; i > 0; i--) {
        const p = x.nodeIds[i - 1], c = x.nodeIds[i];
        if ((p === a && c === b) || (p === b && c === a)) x.nodeIds.splice(i, 0, nid);
      }
    }
  });
  ed().select({ kind: "node", id: nid });
}

// Соединять можно только то, что рядом: защита от случайного клика в другом конце карты
const JOIN_MAX_M = 50;

// Соединить два узла в один: дороги начинают сходиться в узле to
export function joinNodes(from: number, to: number) {
  const d = ed().data!;
  if (from === to) return;
  const a = d.nodes.get(from), b = d.nodes.get(to);
  if (!a || !b) return;
  const far = distM(a.lat, a.lon, b.lat, b.lon);
  if (far > JOIN_MAX_M) return ed().toast(tr("Узлы слишком далеко друг от друга ({0} м). Соединять можно ближе {1} м", Math.round(far), JOIN_MAX_M));
  const ws = [...new Set([...waysWithNode(d, from), ...waysWithNode(d, to)])];
  ed().run(tr("Соединение узлов"), ws, [from, to], () => mergeInto(d, to, from));
  ed().select(null);
  ed().toast(tr("Узлы соединены, дороги теперь связаны"));
}

// Соединить узел с дорогой: узел ставится на ближайшую точку дороги и входит в нее
export function joinNodeToWay(from: number, wayId: number) {
  const d = ed().data!;
  const w = d.ways.get(wayId);
  const n = d.nodes.get(from);
  if (!w || !n) return;
  if (w.nodeIds.includes(from)) return ed().toast(tr("Этот узел уже на этой дороге"));
  const seg = nearestSegment(d, w, n.lat, n.lon);
  if (seg.idx < 0) return;
  // если ближайшая точка почти совпадает с узлом дороги, просто склеиваем узлы
  const [plat, plon] = seg.pr.toLatLon(seg.q[0], seg.q[1]);
  if (seg.dist > JOIN_MAX_M) return ed().toast(tr("Дорога слишком далеко от узла ({0} м). Соединять можно ближе {1} м", Math.round(seg.dist), JOIN_MAX_M));
  for (const id of [w.nodeIds[seg.idx - 1], w.nodeIds[seg.idx]]) {
    const m = d.nodes.get(id)!;
    if (distM(m.lat, m.lon, plat, plon) < 2) return joinNodes(from, id);
  }
  ed().run(tr("Соединение узла с дорогой"), [...new Set([...waysWithNode(d, from), wayId])], [from], () => {
    n.lat = plat; n.lon = plon;
    w.nodeIds.splice(seg.idx, 0, from);
  });
  ed().select(null);
  ed().toast(tr("Узел присоединен к дороге"));
}

// Разъединить: каждая дорога, кроме первой, получает в этом месте свой узел.
// Новые узлы чуть сдвигаются вдоль своей дороги, чтобы их было видно и можно было взять мышкой.
export function unjoinNode(nodeId: number) {
  const d = ed().data!;
  const n = d.nodes.get(nodeId);
  if (!n) return;
  const ws = waysWithNode(d, nodeId);
  if (ws.length < 2) return ed().toast(tr("В этом узле только одна дорога, разъединять нечего"));
  const pr = makeProjection(n.lat, n.lon);
  ed().run(tr("Разъединение дорог в узле"), ws, [nodeId], () => {
    for (const wid of ws.slice(1)) {
      const w = d.ways.get(wid)!;
      const i = w.nodeIds.indexOf(nodeId);
      const nb = d.nodes.get(w.nodeIds[i + 1] ?? w.nodeIds[i - 1])!;
      const [x, y] = pr.toXY(nb.lat, nb.lon);
      const len = Math.hypot(x, y);
      const k = len > 0 ? Math.min(3, len * 0.3) / len : 0;
      const [lat, lon] = pr.toLatLon(x * k, y * k);
      const id = newId();
      d.nodes.set(id, { id, lat, lon, tags: {}, attrs: {} });
      w.nodeIds = w.nodeIds.map((x2) => (x2 === nodeId ? id : x2));
    }
  });
  ed().select({ kind: "node", id: nodeId });
  ed().toast(tr("Дороги в узле разъединены: {0}", ws.length));
}

// Соединить один разорванный перекресток: конец дороги встает на ближайший отрезок другой дороги.
// Только меняет данные, без записи в историю. Возвращает false, если разрыв уже не найти.
function tornFix(d: OsmData, e: GraphError): boolean {
  if (e.node === undefined || !e.seg || !d.nodes.has(e.node)) return false;
  const other = d.ways.get(e.ways[1]);
  if (!other) return false;
  const [a, b] = e.seg;
  let idx = -1;
  for (let i = 1; i < other.nodeIds.length; i++) {
    const x = other.nodeIds[i - 1], y = other.nodeIds[i];
    if ((x === a && y === b) || (x === b && y === a)) idx = i;
  }
  if (idx < 0) return false; // отрезок уже изменился (например, в него встал другой разрыв)
  const pr = makeProjection(e.lat, e.lon);
  const xy = (id: number): [number, number] => { const n = d.nodes.get(id)!; return pr.toXY(n.lat, n.lon); };
  const pa = xy(other.nodeIds[idx - 1]), pb = xy(other.nodeIds[idx]);
  const road0 = d.ways.get(e.ways[0]);
  if (!road0) return false;
  // Последний отрезок дороги уже пересекает соседнюю дорогу (конец торчит за нее): ставим общий узел
  // в точке пересечения, хвост оставляем как есть. Иначе дорога вернулась бы назад зубцом.
  const atEnd = road0.nodeIds[road0.nodeIds.length - 1] === e.node;
  const prevId = atEnd ? road0.nodeIds[road0.nodeIds.length - 2] : road0.nodeIds[1];
  if (prevId !== undefined) {
    const p1 = xy(prevId), p2 = xy(e.node);
    const den = (p2[0] - p1[0]) * (pb[1] - pa[1]) - (p2[1] - p1[1]) * (pb[0] - pa[0]);
    if (Math.abs(den) > 1e-9) {
      const t = ((pa[0] - p1[0]) * (pb[1] - pa[1]) - (pa[1] - p1[1]) * (pb[0] - pa[0])) / den;
      const u = ((pa[0] - p1[0]) * (p2[1] - p1[1]) - (pa[1] - p1[1]) * (p2[0] - p1[0])) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) {
        const X: [number, number] = [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
        let id: number;
        if (Math.hypot(X[0] - pa[0], X[1] - pa[1]) < 0.5) id = other.nodeIds[idx - 1];
        else if (Math.hypot(X[0] - pb[0], X[1] - pb[1]) < 0.5) id = other.nodeIds[idx];
        else {
          const [lat, lon] = pr.toLatLon(X[0], X[1]);
          id = newId();
          d.nodes.set(id, { id, lat, lon, tags: {}, attrs: {} });
          other.nodeIds.splice(idx, 0, id);
        }
        const j = road0.nodeIds.indexOf(e.node);
        road0.nodeIds.splice(atEnd ? j : j + 1, 0, id);
        return true;
      }
    }
  }
  const { q } = project(xy(e.node), pa, pb);
  // Конец дороги не двигаем и не сливаем: он бывает общим с лестницей, забором или входом в здание
  // и несет свои теги. Дорогу продлеваем до точки на соседней дороге (существующей, если она ближе 0,5 м).
  let to: number;
  if (Math.hypot(q[0] - pa[0], q[1] - pa[1]) < 0.5) to = other.nodeIds[idx - 1];
  else if (Math.hypot(q[0] - pb[0], q[1] - pb[1]) < 0.5) to = other.nodeIds[idx];
  else {
    const [lat, lon] = pr.toLatLon(q[0], q[1]);
    to = newId();
    d.nodes.set(to, { id: to, lat, lon, tags: {}, attrs: {} });
    other.nodeIds.splice(idx, 0, to);
  }
  const road = d.ways.get(e.ways[0]);
  if (!road) return false;
  if (road.nodeIds[road.nodeIds.length - 1] === e.node) road.nodeIds.push(to);
  else if (road.nodeIds[0] === e.node) road.nodeIds.unshift(to);
  else return false;
  return true;
}

// Соединить все разрывы сразу. Раньше каждый разрыв был отдельной правкой с полной проверкой графа после нее:
// на большой карте это сотни проверок подряд, и программа зависала. Теперь все разрывы соединяются за один проход
// и граф проверяется один раз; если что-то осталось (два разрыва на одном отрезке), делается еще проход.
export function fixAllTorn(): number {
  let total = 0;
  batch(tr("Соединены все разрывы"), () => {
    for (let pass = 0; pass < 5; pass++) {
      const d = ed().data;
      if (ed().checkStale) ed().recheck(true); // нужен свежий список разрывов
      const errs = ed().check?.errors.filter((x) => x.type === "torn") ?? [];
      if (!d || !errs.length) break;
      // какие дороги и узлы изменятся: нужны для отмены
      const nodes = new Set<number>(), ends = new Set<number>(), ways = new Set<number>();
      for (const e of errs) { if (e.node !== undefined) { nodes.add(e.node); ends.add(e.node); } for (const id of e.seg ?? []) nodes.add(id); ways.add(e.ways[1]); }
      for (const w of d.ways.values()) if (w.nodeIds.some((id) => ends.has(id))) ways.add(w.id);
      let done = 0;
      ed().run(tr("Соединение разрывов"), [...ways], [...nodes], () => { for (const e of errs) if (tornFix(d, e)) done++; });
      total += done;
      if (!done) { useEditor.setState({ past: ed().past.slice(0, -1), log: ed().log.slice(1) }); break; } // пустую правку из истории убираем
    }
  });
  return total;
}

export function fixError(e: GraphError) {
  const d = ed().data!;
  if (e.type === "torn" && e.node !== undefined && e.seg) {
    const other = d.ways.get(e.ways[1]);
    if (!other) return;
    ed().run(tr("Соединение перекрестка"), [...new Set([...waysWithNode(d, e.node), other.id])], [e.node, ...e.seg], () => { tornFix(d, e); });
  }
  if (e.type === "glued" && e.seg1 && e.seg2) {
    ed().run(tr("Узел на пересечении"), e.ways, [], () => {
      const id = newId();
      d.nodes.set(id, { id, lat: e.lat, lon: e.lon, tags: {}, attrs: {} });
      for (const [wid, sg] of [[e.ways[0], e.seg1!], [e.ways[1], e.seg2!]] as const) {
        const w = d.ways.get(wid)!;
        for (let i = 1; i < w.nodeIds.length; i++) if (w.nodeIds[i - 1] === sg[0] && w.nodeIds[i] === sg[1]) { w.nodeIds.splice(i, 0, id); break; }
      }
    });
  }
  if (e.type === "isolated") ed().run(tr("Удален изолированный участок"), e.ways, [], () => { for (const id of e.ways) d.ways.delete(id); });
  if (e.type === "attr") {
    const w = d.ways.get(e.ways[0])!;
    ed().run(tr("Атрибуты по умолчанию"), [w.id], [], () => {
      if (!w.tags.lanes) w.tags.lanes = w.tags.highway === "primary" ? "4" : "2";
      if (!w.tags.maxspeed) w.tags.maxspeed = "60";
    });
  }
  if (e.type === "bridge") ed().run(tr("Мост поднят над дорогой"), e.ways, [], () => { d.ways.get(e.ways[0])!.tags.layer = "1"; });
  if (e.type === "building") bridgeOverBuilding(e.ways[0]);
  if (e.type === "value") {
    const w = d.ways.get(e.ways[0])!;
    // непонятное значение убираем: симулятор возьмет значение по классу дороги, а в панели его можно задать заново
    ed().run(tr("Убраны непонятные значения тегов"), [w.id], [], () => { for (const s of e.bad ?? []) delete w.tags[s.split(/[= ]/)[0]]; });
  }
  if (e.type === "short" && e.seg) joinNodes(e.seg[1], e.seg[0]);
}

// ---------- общие помощники ----------
const DOCK_M = 15; // рельсы стыкуются сами, если конец ближе 15 м
type XY = [number, number];
const unit = (v: XY): XY => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// Плоские координаты в метрах вокруг узла: x на восток, y на север
function local(d: OsmData, lat: number, lon: number) {
  const pr = makeProjection(lat, lon);
  return {
    P: (id: number): XY => { const n = d.nodes.get(id)!; const [x, y] = pr.toXY(n.lat, n.lon); return [x, -y]; },
    // новый узел в точке (x, y)
    add: (p: XY, tags: Tags = {}): number => { const [la, lo] = pr.toLatLon(p[0], -p[1]); const id = newId(); d.nodes.set(id, { id, lat: la, lon: lo, tags, attrs: {} }); return id; },
  };
}

// Ближайший узел подходящих линий не дальше max метров
function nearestNode(d: OsmData, lat: number, lon: number, max: number, fit: (w: OsmWay) => boolean, skip: number[] = []): number | null {
  let best: number | null = null, bd = max;
  for (const w of d.ways.values()) {
    if (!fit(w)) continue;
    for (const id of w.nodeIds) {
      const n = d.nodes.get(id);
      if (!n || skip.includes(id) || Math.abs(n.lat - lat) > 0.0005) continue;
      const dist = distM(lat, lon, n.lat, n.lon);
      if (dist < bd) { bd = dist; best = id; }
    }
  }
  return best;
}

// Проезжие дороги, рамка которых задевает рамку точек: их может пересечь новая линия.
// Сравниваем рамки, а не узлы: длинный отрезок дороги может пройти поперек без узлов рядом.
function roadsNear(d: OsmData, pts: { lat: number; lon: number }[]): number[] {
  const lat0 = Math.min(...pts.map((p) => p.lat)), lat1 = Math.max(...pts.map((p) => p.lat));
  const lon0 = Math.min(...pts.map((p) => p.lon)), lon1 = Math.max(...pts.map((p) => p.lon));
  return [...d.ways.values()].filter((w) => {
    if (!isDrivable(w)) return false;
    let a = Infinity, b = -Infinity, c = Infinity, e = -Infinity;
    for (const id of w.nodeIds) { const n = d.nodes.get(id); if (!n) continue; a = Math.min(a, n.lat); b = Math.max(b, n.lat); c = Math.min(c, n.lon); e = Math.max(e, n.lon); }
    return b >= lat0 && a <= lat1 && e >= lon0 && c <= lon1;
  }).map((w) => w.id);
}

// Где линия way пересекает проезжие дороги на том же уровне без общего узла
function crossingsOf(d: OsmData, way: OsmWay, P: (id: number) => XY) {
  const hits: { i: number; t: number; road: OsmWay; p: XY }[] = [];
  const lay = way.tags.layer ?? "0";
  for (const w of d.ways.values()) {
    if (w.id === way.id || !isDrivable(w) || (w.tags.layer ?? "0") !== lay) continue;
    for (let j = 1; j < w.nodeIds.length; j++) {
      const a = w.nodeIds[j - 1], b = w.nodeIds[j];
      if (way.nodeIds.includes(a) || way.nodeIds.includes(b)) continue;
      const p3 = P(a), p4 = P(b);
      for (let i = 1; i < way.nodeIds.length; i++) {
        const p1 = P(way.nodeIds[i - 1]), p2 = P(way.nodeIds[i]);
        const den = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
        if (Math.abs(den) < 1e-9) continue;
        const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / den;
        const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) hits.push({ i, t, road: w, p: [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] });
      }
    }
  }
  return hits;
}

// Рельсы пересекают дорогу - ставим общий узел-переезд, иначе это ошибка «пересечение без узла»
function addLevelCrossings(d: OsmData, track: OsmWay) {
  const n0 = d.nodes.get(track.nodeIds[0])!;
  const { P, add } = local(d, n0.lat, n0.lon);
  const tag = track.tags.railway === "tram" ? "tram_level_crossing" : "level_crossing";
  // вставляем с конца, чтобы номера отрезков рельсов не сдвигались
  const hits = crossingsOf(d, track, P).sort((a, b) => b.i - a.i || b.t - a.t);
  for (const h of hits) {
    const id = add(h.p, { railway: tag });
    track.nodeIds.splice(h.i, 0, id);
    const n = d.nodes.get(id)!;
    const seg = nearestSegment(d, h.road, n.lat, n.lon);
    if (seg.idx > 0) h.road.nodeIds.splice(seg.idx, 0, id);
  }
}

// ---------- несколько дорог и участок между узлами ----------

// Shift+клик по дороге: добавить к выделению или убрать из него
export function toggleWay(id: number) {
  const s = ed().selection;
  const ids = s?.kind === "way" ? [s.id] : s?.kind === "ways" && !s.section ? [...s.ids] : [];
  const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  ed().select(next.length === 0 ? null : next.length === 1 ? { kind: "way", id: next[0] } : { kind: "ways", ids: next });
}

const adjacentIn = (w: OsmWay, x: number, y: number) => w.nodeIds.some((id, i) => i > 0 && ((w.nodeIds[i - 1] === x && id === y) || (w.nodeIds[i - 1] === y && id === x)));

// Кратчайший путь между двумя узлами по проезжим дорогам (направления не учитываем)
export function findSection(a: number, b: number): Section | null {
  const d = ed().data!;
  const adj = new Map<number, [number, number][]>();
  const link = (x: number, y: number, l: number) => { if (!adj.has(x)) adj.set(x, []); adj.get(x)!.push([y, l]); };
  for (const w of d.ways.values()) {
    if (!isDrivable(w)) continue;
    for (let i = 1; i < w.nodeIds.length; i++) {
      const p = d.nodes.get(w.nodeIds[i - 1]), q = d.nodes.get(w.nodeIds[i]);
      if (!p || !q) continue;
      const l = distM(p.lat, p.lon, q.lat, q.lon);
      link(p.id, q.id, l); link(q.id, p.id, l);
    }
  }
  // алгоритм Дейкстры с двоичной кучей
  const dist = new Map<number, number>([[a, 0]]), prev = new Map<number, number>();
  const heap: [number, number][] = [[0, a]];
  const push = (e: [number, number]) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [dv, v] = pop();
    if (v === b) break;
    if (dv > dist.get(v)!) continue;
    for (const [u, l] of adj.get(v) ?? []) if (dv + l < (dist.get(u) ?? Infinity)) { dist.set(u, dv + l); prev.set(u, v); push([dv + l, u]); }
  }
  if (!dist.has(b) || a === b) return null;
  const nodes = [b];
  while (nodes[nodes.length - 1] !== a) nodes.push(prev.get(nodes[nodes.length - 1])!);
  return { from: a, to: b, nodes: nodes.reverse(), length: dist.get(b)! };
}

// Дороги, по которым идет участок
export function sectionWays(nodes: number[]): number[] {
  const d = ed().data!;
  const out = new Set<number>();
  const ws = [...d.ways.values()].filter(isDrivable);
  for (let i = 1; i < nodes.length; i++) { const w = ws.find((x) => adjacentIn(x, nodes[i - 1], nodes[i])); if (w) out.add(w.id); }
  return [...out];
}

export function selectSection(a: number, b: number) {
  const s = findSection(a, b);
  if (!s) return ed().toast(tr("Между этими узлами нет пути по дорогам"));
  ed().select({ kind: "ways", ids: sectionWays(s.nodes), section: s });
  ed().toast(tr("Участок между узлами: {0} м. Изменения применятся только к нему", Math.round(s.length)));
}

// Отрезать от дороги часть между узлами x и y. Сама дорога становится этой частью, остальное - новые дороги.
function cutWay(d: OsmData, w: OsmWay, x: number, y: number): number {
  const ids = w.nodeIds;
  if (ids[0] === ids[ids.length - 1]) return w.id; // замкнутую (кольцо) не режем
  const i1 = ids.indexOf(x), i2 = ids.indexOf(y);
  const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
  if (lo > 0) { const id = newId(); d.ways.set(id, { id, nodeIds: ids.slice(0, lo + 1), tags: { ...w.tags }, attrs: {} }); }
  if (hi < ids.length - 1) { const id = newId(); d.ways.set(id, { id, nodeIds: ids.slice(hi), tags: { ...w.tags }, attrs: {} }); }
  w.nodeIds = ids.slice(lo, hi + 1);
  return w.id;
}

// Разрезать дороги по краям участка, вернуть дороги, из которых теперь состоит участок
function splitSection(d: OsmData, nodes: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < nodes.length - 1) {
    const w = [...d.ways.values()].find((x) => isDrivable(x) && adjacentIn(x, nodes[i], nodes[i + 1]));
    if (!w) { i++; continue; }
    let j = i + 1;
    while (j < nodes.length - 1 && adjacentIn(w, nodes[j], nodes[j + 1])) j++;
    out.push(cutWay(d, w, nodes[i], nodes[j]));
    i = j;
  }
  return [...new Set(out)];
}

// Изменить теги сразу у всех выделенных дорог или у участка между узлами
export function patchSelection(patch: Tags, remove: string[], label: string) {
  const s = ed().selection, d = ed().data!;
  if (s?.kind !== "ways") return;
  const apply = (w: OsmWay) => {
    const t = { ...w.tags, ...patch };
    for (const k of remove) delete t[k];
    for (const k of Object.keys(t)) if (t[k] === "") delete t[k];
    w.tags = t;
  };
  if (!s.section) {
    ed().run(tr("{0} (дорог: {1})", label, s.ids.length), s.ids, [], () => { for (const id of s.ids) { const w = d.ways.get(id); if (w) apply(w); } });
    return;
  }
  const nodes = s.section.nodes;
  let result: number[] = [];
  ed().run(label + tr(" на участке"), sectionWays(nodes), [], () => {
    result = splitSection(d, nodes);
    for (const id of result) apply(d.ways.get(id)!);
  });
  // после разрезания участок - это просто набор дорог
  ed().select(result.length === 1 ? { kind: "way", id: result[0] } : result.length ? { kind: "ways", ids: result } : null);
}

export function deleteWays(ids: number[]) {
  const d = ed().data!;
  ed().run(tr("Удаление дорог: {0}", ids.length), ids, [], () => { for (const id of ids) d.ways.delete(id); });
  ed().select(null);
}

// ---------- шаблоны-вставки ----------
const drivableWith = (d: OsmData, nodeId: number) => [...d.ways.values()].filter((w) => isDrivable(w) && w.nodeIds.includes(nodeId));

// Перекресток превращается в круговое движение радиусом R метров
export function makeRoundabout(nodeId: number, R = 18) {
  const d = ed().data!;
  const x0 = d.nodes.get(nodeId);
  const ws = drivableWith(d, nodeId);
  if (!x0 || !ws.length) return ed().toast(tr("Кольцо ставится в узел дороги"));
  if (ws.some((w) => w.tags.junction === "roundabout")) return ed().toast(tr("Здесь уже круговое движение"));
  // дорога-петля проходит через узел дважды: рукава такой дороги не разобрать, а узел остался бы в ней после удаления
  if (ws.some((w) => w.nodeIds.indexOf(nodeId) !== w.nodeIds.lastIndexOf(nodeId))) return ed().toast(tr("Кольцо не ставится в узел, через который дорога проходит дважды (петля). Сначала разрежьте петлю"));
  const { P, add } = local(d, x0.lat, x0.lon);
  const usedElsewhere = [...d.ways.values()].some((w) => !ws.includes(w) && w.nodeIds.includes(nodeId));
  const main = ws.reduce((a, b) => (roadClass(b).rank > roadClass(a).rank ? b : a));
  let ring = 0;
  ed().run(tr("Круговое движение"), ws.map((w) => w.id), [nodeId], () => {
    const entries: { id: number; ang: number }[] = [];
    // идем от центра по рукаву до первого узла за окружностью, там ставим въезд на кольцо
    const arm = (path: number[]): { keep: number[]; entry: number } | null => {
      for (let k = 1; k < path.length; k++) {
        const p = P(path[k]);
        if (Math.hypot(p[0], p[1]) < R) continue;
        const q = P(path[k - 1]), v: XY = [p[0] - q[0], p[1] - q[1]];
        const A = v[0] ** 2 + v[1] ** 2, B = 2 * (q[0] * v[0] + q[1] * v[1]), C = q[0] ** 2 + q[1] ** 2 - R * R;
        const t = (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
        const e: XY = [q[0] + t * v[0], q[1] + t * v[1]];
        const id = add(e);
        entries.push({ id, ang: Math.atan2(e[1], e[0]) });
        return { keep: path.slice(k), entry: id };
      }
      return null; // рукав короче радиуса кольца
    };
    for (const w of ws) {
      const ids = w.nodeIds, i = ids.indexOf(nodeId);
      const before = i > 0 ? arm(ids.slice(0, i + 1).reverse()) : null;
      const after = i < ids.length - 1 ? arm(ids.slice(i)) : null;
      const parts: number[][] = [];
      if (before) parts.push([...before.keep.reverse(), before.entry]);
      if (after) parts.push([after.entry, ...after.keep]);
      if (!parts.length) { d.ways.delete(w.id); continue; }
      w.nodeIds = parts[0];
      if (parts[1]) { const id = newId(); d.ways.set(id, { id, nodeIds: parts[1], tags: { ...w.tags }, attrs: {} }); }
    }
    // точки кольца через 22,5° и въезды; порядок против часовой стрелки (правостороннее движение)
    const pts = [...entries];
    for (let k = 0; k < 16; k++) {
      const ang = -Math.PI + (k * Math.PI) / 8;
      if (entries.some((e) => Math.abs(angDiff(e.ang, ang)) < 0.2)) continue;
      pts.push({ id: add([R * Math.cos(ang), R * Math.sin(ang)]), ang });
    }
    pts.sort((a, b) => a.ang - b.ang);
    ring = newId();
    d.ways.set(ring, { id: ring, nodeIds: [...pts.map((p) => p.id), pts[0].id], tags: { highway: main.tags.highway, junction: "roundabout", lanes: "2", maxspeed: "40", surface: main.tags.surface ?? "asphalt" }, attrs: {} });
    if (!usedElsewhere) d.nodes.delete(nodeId);
  });
  ed().select({ kind: "way", id: ring });
  ed().toast(tr("Перекресток заменен круговым движением"));
}

// Направление дороги в узле: на конце - куда дорога «продолжилась бы», в середине - по ходу линии
function roadDir(d: OsmData, w: OsmWay, nodeId: number, P: (id: number) => XY) {
  const ids = w.nodeIds, i = ids.indexOf(nodeId);
  const end = i === 0 || i === ids.length - 1;
  if (end) { const nb = P(ids[i === 0 ? 1 : i - 1]); return { end, dir: unit([-nb[0], -nb[1]]) }; }
  const a = P(ids[i - 1]), b = P(ids[i + 1]);
  return { end, dir: unit([b[0] - a[0], b[1] - a[1]]) };
}

// Разворотная петля: на конце дороги - вперед, в середине - вправо от направления линии
export function makeUturn(nodeId: number, R = 12) {
  const d = ed().data!;
  const n = d.nodes.get(nodeId);
  const w = drivableWith(d, nodeId)[0];
  if (!n || !w) return ed().toast(tr("Разворот ставится в узел дороги"));
  const { P, add } = local(d, n.lat, n.lon);
  const { end, dir } = roadDir(d, w, nodeId, P);
  const out: XY = end ? dir : [dir[1], -dir[0]];
  const c: XY = [out[0] * R, out[1] * R];
  const a0 = Math.atan2(-out[1], -out[0]);
  let id = 0;
  ed().run(tr("Шаблон: разворот на 180°"), [], [], () => {
    const loop = [nodeId];
    for (let k = 1; k < 16; k++) loop.push(add([c[0] + R * Math.cos(a0 + (k * Math.PI) / 8), c[1] + R * Math.sin(a0 + (k * Math.PI) / 8)]));
    loop.push(nodeId);
    id = newId();
    d.ways.set(id, { id, nodeIds: loop, tags: { highway: "service", service: "turnaround", lanes: "1", maxspeed: "20", surface: w.tags.surface ?? "asphalt" }, attrs: {} });
  });
  ed().select({ kind: "way", id });
}

// Поворот на 90°: продолжение дороги с конца дугой радиусом R и прямым участком
export function makeTurn(nodeId: number, side: "left" | "right", R = 15, tail = 30) {
  const d = ed().data!;
  const n = d.nodes.get(nodeId);
  const ws = drivableWith(d, nodeId);
  if (!n || ws.length !== 1) return ed().toast(tr("Поворот продолжает дорогу: выберите конечный узел дороги"));
  const w = ws[0];
  const { P, add } = local(d, n.lat, n.lon);
  const { end, dir } = roadDir(d, w, nodeId, P);
  if (!end) return ed().toast(tr("Поворот продолжает дорогу: выберите конечный узел дороги"));
  const sg = side === "left" ? 1 : -1;
  const nrm: XY = [-dir[1] * sg, dir[0] * sg];
  const c: XY = [nrm[0] * R, nrm[1] * R];
  const a0 = Math.atan2(-nrm[1], -nrm[0]);
  let id = 0;
  ed().run(tr("Шаблон: поворот на 90° {0}", side === "left" ? tr("влево") : tr("вправо")), [], [], () => {
    const pts = [nodeId];
    let last: XY = [0, 0];
    for (let k = 1; k <= 6; k++) { last = [c[0] + R * Math.cos(a0 + (sg * k * Math.PI) / 12), c[1] + R * Math.sin(a0 + (sg * k * Math.PI) / 12)]; pts.push(add(last)); }
    pts.push(add([last[0] + nrm[0] * tail, last[1] + nrm[1] * tail]));
    id = newId();
    const t = { ...w.tags };
    delete t.name;
    d.ways.set(id, { id, nodeIds: pts, tags: t, attrs: {} });
  });
  ed().select({ kind: "way", id });
}

// Мост на дороге: над пересечением с другой дорогой (или посередине), по half метров в каждую сторону
// span - готовый участок моста в метрах от начала дороги (мост над зданием)
export function insertBridge(wayId: number, half = 25, span?: [number, number], layer = 1) {
  const d = ed().data!;
  const w = d.ways.get(wayId);
  if (!w) return;
  const n0 = d.nodes.get(w.nodeIds[0])!;
  const { P, add } = local(d, n0.lat, n0.lon);
  // расстояние вдоль дороги до каждого узла
  const s = [0];
  for (let i = 1; i < w.nodeIds.length; i++) { const a = P(w.nodeIds[i - 1]), b = P(w.nodeIds[i]); s.push(s[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const L = s[s.length - 1];
  const hits = crossingsOf(d, w, P).map((h) => s[h.i - 1] + h.t * (s[h.i] - s[h.i - 1]));
  const at = hits.length ? hits.sort((a, b) => Math.abs(a - L / 2) - Math.abs(b - L / 2))[0] : L / 2;
  const bridgeTags = (x: OsmWay) => { x.tags = { ...x.tags, bridge: "yes", layer: String(layer) }; delete x.tags.tunnel; };
  if (span ? span[1] - span[0] > L - 6 : L < 2 * half + 10) {
    ed().run(tr("Шаблон: мост"), [wayId], [], () => bridgeTags(w));
    return ed().toast(tr("Дорога короткая: мостом стала вся"));
  }
  // узел в точке на расстоянии x от начала дороги (существующий, если он ближе 3 м)
  const nodeAt = (x: number) => {
    const i = s.findIndex((v) => v >= x);
    if (Math.abs(s[i] - x) < 3) return w.nodeIds[i];
    if (i > 0 && Math.abs(s[i - 1] - x) < 3) return w.nodeIds[i - 1];
    const a = P(w.nodeIds[i - 1]), b = P(w.nodeIds[i]), t = (x - s[i - 1]) / (s[i] - s[i - 1]);
    const id = add([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    w.nodeIds.splice(i, 0, id);
    s.splice(i, 0, x);
    return id;
  };
  ed().run(tr("Шаблон: мост"), [wayId], [], () => {
    const [x1, x2] = span ?? [at - half, at + half];
    const n1 = nodeAt(Math.max(0, x1)), n2 = nodeAt(Math.min(L, x2));
    bridgeTags(d.ways.get(cutWay(d, w, n1, n2))!);
  });
  ed().select({ kind: "way", id: wayId });
  ed().toast(span ? tr("Мост поставлен над зданием, высота по крыше") : hits.length ? tr("Мост поставлен над пересечением с другой дорогой") : tr("Мост поставлен в середине дороги"));
}

// Мост над зданием, сквозь которое идет дорога: от 12 м до здания до 12 м после
export function bridgeOverBuilding(wayId: number) {
  const d = ed().data!;
  const w = d.ways.get(wayId);
  if (!w) return;
  const ix = buildingIndex(d);
  let s = 0, first = -1, last = -1, roof = 0;
  for (let i = 1; i < w.nodeIds.length; i++) {
    const a = d.nodes.get(w.nodeIds[i - 1])!, b = d.nodes.get(w.nodeIds[i])!;
    const len = distM(a.lat, a.lon, b.lat, b.lon), n = Math.max(1, Math.ceil(len));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const bl = buildingAt(ix, { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
      if (bl) { if (first < 0) first = s + len * t; last = s + len * t; roof = Math.max(roof, bl.h); }
    }
    s += len;
  }
  if (first < 0) return ed().toast(tr("Здание под дорогой не найдено"));
  // уровень моста: по 6 м на уровень, выше крыши хотя бы на 4 м (симуляторы читают layer)
  insertBridge(wayId, 25, [first - 12, last + 12], Math.max(1, Math.ceil((roof + 4) / 6)));
}

// ---------- пешеходный переход ----------
const crossingWays = (d: OsmData, nodeId: number) => [...d.ways.values()].filter((w) => w.tags.footway === "crossing" && w.nodeIds.includes(nodeId));

// Переход: узел на дороге и пешеходная дорожка поперек нее. arm - через какой рукав перекрестка (в 10 м от центра)
export function setCrossing(nodeId: number, arm: Arm | null, signals: boolean) {
  const d = ed().data!;
  const x = d.nodes.get(nodeId);
  const road = arm ? d.ways.get(arm.wayId) : drivableWith(d, nodeId)[0];
  if (!x || !road) return;
  const kind = signals ? "traffic_signals" : "uncontrolled";
  const old = crossingWays(d, nodeId);
  ed().run(tr("Пешеходный переход"), [road.id, ...old.map((w) => w.id)], [nodeId], () => {
    for (const w of old) d.ways.delete(w.id);
    const { P, add } = local(d, x.lat, x.lon);
    let c = nodeId;
    if (arm) {
      const nb = P(arm.nb), len = Math.hypot(nb[0], nb[1]), k = Math.min(10, len / 2) / len;
      c = add([nb[0] * k, nb[1] * k]);
      for (let i = 1; i < road.nodeIds.length; i++) {
        const p = road.nodeIds[i - 1], q = road.nodeIds[i];
        if ((p === nodeId && q === arm.nb) || (p === arm.nb && q === nodeId)) { road.nodeIds.splice(i, 0, c); break; }
      }
    }
    const { dir } = roadDir(d, road, c, P);
    const across: XY = [-dir[1], dir[0]];
    const p0 = P(c), hw = (lanesOf(road) * 3.5) / 2 + 2;
    const a = add([p0[0] + across[0] * hw, p0[1] + across[1] * hw]), b = add([p0[0] - across[0] * hw, p0[1] - across[1] * hw]);
    const id = newId();
    d.ways.set(id, { id, nodeIds: [a, c, b], tags: { highway: "footway", footway: "crossing", crossing: kind }, attrs: {} });
    const cn = d.nodes.get(c)!;
    cn.tags = { ...cn.tags, highway: cn.tags.highway === "traffic_signals" ? "traffic_signals" : "crossing", crossing: kind };
    if (c !== nodeId) newCrossing = c;
  });
  ed().toast(arm ? tr("Переход через «{0}» поставлен в 10 м от перекрестка", arm.name) : tr("Переход поставлен"));
  if (newCrossing) { ed().select({ kind: "node", id: newCrossing }); newCrossing = 0; }
}
let newCrossing = 0;

export function removeCrossing(nodeId: number) {
  const d = ed().data!;
  const ws = crossingWays(d, nodeId);
  const ends = ws.flatMap((w) => w.nodeIds.filter((id) => id !== nodeId));
  ed().run(tr("Переход убран"), ws.map((w) => w.id), [nodeId, ...ends], () => {
    for (const w of ws) d.ways.delete(w.id);
    // концы дорожки удаляем, если они больше ни к чему не относятся
    for (const id of ends) if (![...d.ways.values()].some((w) => w.nodeIds.includes(id))) d.nodes.delete(id);
    const n = d.nodes.get(nodeId)!;
    const t = { ...n.tags };
    if (t.highway === "crossing") delete t.highway;
    delete t.crossing;
    n.tags = t;
  });
}

// Поменять, откуда и куда идет переход (порядок дорожки)
export function flipCrossing(nodeId: number) {
  const d = ed().data!;
  const ws = crossingWays(d, nodeId);
  ed().run(tr("Направление перехода"), ws.map((w) => w.id), [], () => { for (const w of ws) w.nodeIds.reverse(); });
}

export function crossingOf(nodeId: number): OsmWay | undefined {
  return crossingWays(ed().data!, nodeId)[0];
}

// ---------- трамвай по дороге ----------
export const embeddedTram = (d: OsmData, road: OsmWay) => [...d.ways.values()].filter((t) => t.tags.railway === "tram" && t.tags.embedded === "yes" && t.nodeIds.filter((id) => road.nodeIds.includes(id)).length >= 2);

export function setTramOnRoad(wayId: number, on: boolean) {
  const d = ed().data!;
  const w = d.ways.get(wayId);
  if (!w) return;
  const old = embeddedTram(d, w);
  if (!on) {
    ed().run(tr("Трамвай убран с дороги"), [wayId, ...old.map((t) => t.id)], [], () => {
      for (const t of old) d.ways.delete(t.id);
      const t = { ...w.tags }; delete t.embedded_rails; w.tags = t;
    });
    return;
  }
  if (old.length) return;
  let docked = 0;
  ed().run(tr("Трамвай по дороге"), [wayId], [], () => {
    w.tags = { ...w.tags, embedded_rails: "tram" };
    const ids = [...w.nodeIds];
    // стыковка: концы путей тянем к ближайшим трамвайным путям не дальше 15 м
    for (const atStart of [true, false]) {
      const n = d.nodes.get(atStart ? ids[0] : ids[ids.length - 1])!;
      const near = nearestNode(d, n.lat, n.lon, DOCK_M, (t) => t.tags.railway === "tram", ids);
      if (near === null) continue;
      if (atStart) ids.unshift(near); else ids.push(near);
      docked++;
    }
    const id = newId();
    d.ways.set(id, { id, nodeIds: ids, tags: { railway: "tram", embedded: "yes" }, attrs: {} });
  });
  ed().toast(docked ? tr("Трамвайные пути по дороге проложены и состыкованы с соседними: {0}", docked) : tr("Трамвайные пути проложены по дороге"));
}

// ---------- свои шаблоны ----------
const round1 = (v: number) => Math.round(v * 10) / 10;

// Шаблон из выделенных дорог: точки в метрах от их центра
export function templateFromWays(ids: number[], name: string): CustomTemplate | null {
  const d = ed().data!;
  const ws = ids.map((id) => d.ways.get(id)).filter(Boolean) as OsmWay[];
  const all = ws.flatMap((w) => w.nodeIds.map((id) => d.nodes.get(id)!)).filter(Boolean);
  if (!all.length) return null;
  const lat = all.reduce((s, n) => s + n.lat, 0) / all.length, lon = all.reduce((s, n) => s + n.lon, 0) / all.length;
  const { P } = local(d, lat, lon);
  const lines = ws.map((w) => {
    const closed = w.nodeIds.length > 2 && w.nodeIds[0] === w.nodeIds[w.nodeIds.length - 1];
    const tags = { ...w.tags };
    for (const k of ["name", "wayfinders:volume", "wayfinders:travel_time"]) delete tags[k];
    return { tags, closed, pts: (closed ? w.nodeIds.slice(0, -1) : w.nodeIds).map((id): XY => { const p = P(id); return [round1(p[0]), round1(p[1])]; }) };
  });
  return { id: Date.now().toString(36), name, lines };
}

// Вставить шаблон в точку. Одинаковые точки разных линий становятся одним узлом, так линии связаны.
export function insertTemplate(t: CustomTemplate, lat: number, lon: number) {
  const d = ed().data!;
  const { add } = local(d, lat, lon);
  const made: number[] = [];
  ed().run(tr("Шаблон: ") + t.name, [], [], () => {
    const byPos = new Map<string, number>();
    for (const line of t.lines) {
      const ids = line.pts.map((p) => { const k = p.join(":"); if (!byPos.has(k)) byPos.set(k, add(p)); return byPos.get(k)!; });
      if (line.closed && ids.length > 2) ids.push(ids[0]);
      if (ids.length < 2) continue;
      const id = newId();
      d.ways.set(id, { id, nodeIds: ids, tags: { ...line.tags }, attrs: {} });
      made.push(id);
    }
  });
  ed().select(made.length === 1 ? { kind: "way", id: made[0] } : made.length ? { kind: "ways", ids: made } : null);
}

// ---------- соединение карт ----------
// Добавить к открытой карте еще одну (файл или район из OpenStreetMap).
// Одни и те же элементы OSM (тот же id и то же место) не дублируются.
// Если id совпал, а это другой элемент (например, новые дороги из разных сохраненных файлов), он получает новый id.
// Дороги на стыке сшиваются в общий узел: концы ближе 1,5 м, узлы в середине дороги ближе 0,5 м.
export function mergeMap(extra: OsmData, name: string) {
  const st = ed(), d = st.data;
  if (!d || !st.original) return null;
  const nodeMap = new Map<number, number>(), wayMap = new Map<number, number>();
  const addedNodes: number[] = [], addedWays: number[] = [];

  for (const n of extra.nodes.values()) {
    const old = d.nodes.get(n.id);
    if (old && distM(old.lat, old.lon, n.lat, n.lon) < 1) { nodeMap.set(n.id, n.id); continue; }
    // узел удален в редакторе - не возвращаем его
    if (!old && inOriginal("nodes", n.id)) continue;
    const id = old || n.id < 0 ? newId() : n.id;
    nodeMap.set(n.id, id);
    d.nodes.set(id, { ...n, id, tags: { ...n.tags }, attrs: { ...n.attrs } });
    addedNodes.push(id);
  }
  for (const w of extra.ways.values()) {
    const ids = w.nodeIds.map((x) => nodeMap.get(x)).filter((x): x is number => x !== undefined);
    if (ids.length < 2) continue;
    const old = d.ways.get(w.id);
    if (!old && inOriginal("ways", w.id)) continue; // удалена в редакторе
    if (old && old.nodeIds.some((x) => ids.includes(x))) { wayMap.set(w.id, w.id); continue; } // та же дорога
    const id = old || w.id < 0 ? newId() : w.id;
    wayMap.set(w.id, id);
    d.ways.set(id, { ...w, id, nodeIds: ids, tags: { ...w.tags }, attrs: { ...w.attrs } });
    addedWays.push(id);
  }
  for (const r of extra.relations.values()) {
    if (d.relations.has(r.id) || inOriginal("relations", r.id)) continue;
    const members = r.members.map((m) => ({ ...m, ref: m.type === "node" ? nodeMap.get(m.ref) ?? m.ref : m.type === "way" ? wayMap.get(m.ref) ?? m.ref : m.ref }));
    d.relations.set(r.id, { ...r, members, tags: { ...r.tags }, attrs: { ...r.attrs } });
  }

  // сшивка стыка: концы новых дорог, совпадающие с узлами старых дорог
  const cell = (lat: number, lon: number) => Math.round(lat * 50000) + ":" + Math.round(lon * 30000);
  const oldRoadNodes = new Map<string, number[]>();
  const added = new Set(addedNodes), addedW = new Set(addedWays);
  for (const w of d.ways.values()) {
    if (!isDrivable(w) || addedW.has(w.id)) continue;
    for (const id of w.nodeIds) {
      if (added.has(id)) continue;
      const n = d.nodes.get(id)!;
      const k = cell(n.lat, n.lon);
      if (!oldRoadNodes.has(k)) oldRoadNodes.set(k, []);
      oldRoadNodes.get(k)!.push(id);
    }
  }
  // концы дорог сшиваем ближе 1,5 м, узлы в середине дороги - только если совпадают (ближе 0,5 м)
  let stitched = 0;
  const done = new Set<number>();
  for (const wid of addedWays) {
    const w = d.ways.get(wid);
    if (!w || !isDrivable(w)) continue;
    for (const id of [...w.nodeIds]) {
      const n = d.nodes.get(id);
      if (!n || !added.has(id) || done.has(id)) continue;
      done.add(id);
      const end = id === w.nodeIds[0] || id === w.nodeIds[w.nodeIds.length - 1];
      const [ci, cj] = cell(n.lat, n.lon).split(":").map(Number);
      let best: number | null = null, bd = end ? 1.5 : 0.5;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const o of oldRoadNodes.get(ci + a + ":" + (cj + b)) ?? []) {
          const m = d.nodes.get(o);
          if (!m) continue;
          const dist = distM(n.lat, n.lon, m.lat, m.lon);
          if (dist < bd) { bd = dist; best = o; }
        }
      }
      if (best !== null) { mergeInto(d, best, id); stitched++; }
    }
  }

  // общая рамка карты
  const b = d.bounds, e = extra.bounds;
  if (e) d.bounds = b ? { minlat: Math.min(b.minlat, e.minlat), minlon: Math.min(b.minlon, e.minlon), maxlat: Math.max(b.maxlat, e.maxlat), maxlon: Math.max(b.maxlon, e.maxlon) } : { ...e };

  // присоединенная карта - часть исходника: «Сравнение» и «Правки» не считают ее правкой.
  // Новые элементы не попадают в список правок, значит они уже «исходные»
  const res = { nodes: addedNodes.length, ways: addedWays.length, stitched };
  useEditor.setState({ original: { ...st.original }, log: [{ label: tr("Присоединена карта {0}: линий {1}, сшито на стыке {2}", name, res.ways, stitched), time: new Date() }, ...st.log] });
  ed().recheck();
  return res;
}

// Несколько правок подряд как одна: одна строка в истории и одна отмена Ctrl+Z
export function batch(label: string, f: () => void): number {
  const before = ed().past.length;
  f();
  const st = ed();
  const cmds = st.past.slice(before);
  if (cmds.length < 2) return cmds.length;
  const cmd: Command = {
    label,
    time: new Date(),
    undo: () => { for (const c of [...cmds].reverse()) c.undo(); },
    redo: () => { for (const c of cmds) c.redo(); },
  };
  useEditor.setState({ past: [...st.past.slice(0, before), cmd], future: [], log: [{ label, time: cmd.time }, ...st.log.slice(cmds.length)] });
  return cmds.length;
}
