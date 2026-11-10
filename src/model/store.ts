// Состояние редактора и все операции правки с отменой (Ctrl+Z)
import { create } from "zustand";
import type { OsmData, OsmNode, OsmWay, Tags } from "../osm/types";
import { cloneData } from "../osm/types";
import { validate, type GraphError, type ValidationResult } from "./validate";
import { DEFAULT_NORMS, type Norms } from "./calc";
import { distM, makeProjection, project } from "./geo";

export type Selection = { kind: "way"; id: number } | { kind: "node"; id: number } | null;
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
  original: OsmData | null; // исходник для сравнения "до / после"
  fileName: string;
  filePath: string | null;
  selection: Selection;
  tool: Tool;
  version: number; // растет после каждой правки, по нему перерисовывается интерфейс
  past: Command[];
  future: Command[];
  log: { label: string; time: Date }[];
  check: ValidationResult | null;
  ignored: Set<string>;
  norms: Norms;
  analysis: number[]; // дороги, добавленные в расчет
  focus: { lat: number; lon: number; zoom?: number; t: number } | null;
  highlight: number[];
  message: { text: string; t: number } | null;

  load: (data: OsmData, fileName: string, filePath: string | null) => void;
  select: (s: Selection) => void;
  setTool: (t: Tool) => void;
  run: (label: string, ways: number[], nodes: number[], mutate: () => void) => void;
  undo: () => void;
  redo: () => void;
  recheck: () => void;
  toast: (text: string) => void;
  flyTo: (lat: number, lon: number, zoom?: number) => void;
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
export const newId = () => nextId--;

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
  log: [],
  check: null,
  ignored: new Set(),
  norms: DEFAULT_NORMS,
  analysis: [],
  focus: null,
  highlight: [],
  message: null,

  load: (data, fileName, filePath) => {
    nextId = -1;
    set({ data, original: cloneData(data), fileName, filePath, selection: null, past: [], future: [], log: [], ignored: new Set(), analysis: [], highlight: [], version: get().version + 1 });
    get().recheck();
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
    const afterW = snapWays(d, [...beforeW.keys()]), afterN = snapNodes(d, [...beforeN.keys()]);
    const cmd: Command = { label, time: new Date(), undo: () => restore(d, beforeW, beforeN), redo: () => restore(d, afterW, afterN) };
    set({ past: [...get().past, cmd], future: [], log: [{ label, time: cmd.time }, ...get().log] });
    get().recheck();
  },
  undo: () => {
    const past = [...get().past];
    const cmd = past.pop();
    if (!cmd) return get().toast("Нечего отменять");
    cmd.undo();
    set({ past, future: [cmd, ...get().future], log: [{ label: "Отмена: " + cmd.label, time: new Date() }, ...get().log] });
    fixSelection(get, set);
    get().recheck();
    get().toast("Отменено: " + cmd.label);
  },
  redo: () => {
    const [cmd, ...rest] = get().future;
    if (!cmd) return get().toast("Нечего повторять");
    cmd.redo();
    set({ past: [...get().past, cmd], future: rest, log: [{ label: "Повтор: " + cmd.label, time: new Date() }, ...get().log] });
    fixSelection(get, set);
    get().recheck();
  },
  recheck: () => {
    const d = get().data;
    set({ check: d ? validate(d, get().ignored) : null, version: get().version + 1 });
  },
  toast: (text) => set({ message: { text, t: Date.now() } }),
  flyTo: (lat, lon, zoom) => set({ focus: { lat, lon, zoom, t: Date.now() } }),
  setNorms: (norms) => set({ norms, version: get().version + 1 }),
  setAnalysis: (analysis) => set({ analysis, version: get().version + 1 }),
  ignore: (key) => { const s = new Set(get().ignored); s.add(key); set({ ignored: s }); get().recheck(); },
  setHighlight: (highlight) => set({ highlight, version: get().version + 1 }),
  bump: () => set({ version: get().version + 1 }),
}));

function fixSelection(get: () => EditorState, set: (p: Partial<EditorState>) => void) {
  const { selection: s, data } = get();
  if (!s || !data) return;
  if ((s.kind === "way" && !data.ways.has(s.id)) || (s.kind === "node" && !data.nodes.has(s.id))) set({ selection: null });
}

// ---------- операции правки ----------
const ed = () => useEditor.getState();
const waysWithNode = (d: OsmData, id: number) => [...d.ways.values()].filter((w) => w.nodeIds.includes(id)).map((w) => w.id);

export function setWayTags(wayId: number, tags: Tags, label: string) {
  const d = ed().data!;
  ed().run(label, [wayId], [], () => { const w = d.ways.get(wayId); if (w) w.tags = { ...tags }; });
}

export function setNodeTags(nodeId: number, tags: Tags, label: string) {
  const d = ed().data!;
  ed().run(label, [], [nodeId], () => { const n = d.nodes.get(nodeId); if (n) n.tags = { ...tags }; });
}

export function moveNodeDone(nodeId: number, from: [number, number]) {
  // узел уже передвинут во время перетаскивания, записываем команду в историю
  const d = ed().data!;
  const n = d.nodes.get(nodeId)!;
  const to: [number, number] = [n.lat, n.lon];
  n.lat = from[0]; n.lon = from[1];
  ed().run("Перенос узла", [], [nodeId], () => { n.lat = to[0]; n.lon = to[1]; });
}

export function addWay(points: { id: number | null; lat: number; lon: number }[], tags: Tags) {
  const d = ed().data!;
  let wid = 0;
  ed().run("Новая дорога", [], [], () => {
    const ids = points.map((p) => {
      if (p.id !== null) return p.id;
      const id = newId();
      d.nodes.set(id, { id, lat: p.lat, lon: p.lon, tags: {}, attrs: {} });
      return id;
    });
    wid = newId();
    d.ways.set(wid, { id: wid, nodeIds: ids, tags: { ...tags }, attrs: {} });
  });
  ed().select({ kind: "way", id: wid });
}

export function deleteWay(wayId: number) {
  const d = ed().data!;
  ed().run("Удаление дороги", [wayId], [], () => { d.ways.delete(wayId); });
  ed().select(null);
}

export function deleteNode(nodeId: number) {
  const d = ed().data!;
  const ws = waysWithNode(d, nodeId);
  ed().run("Удаление узла", ws, [nodeId], () => {
    for (const id of ws) {
      const w = d.ways.get(id)!;
      w.nodeIds = w.nodeIds.filter((x) => x !== nodeId);
      if (w.nodeIds.length < 2) d.ways.delete(id);
    }
    d.nodes.delete(nodeId);
  });
  ed().select(null);
}

export function reverseWay(wayId: number) {
  const d = ed().data!;
  ed().run("Разворот направления", [wayId], [], () => { const w = d.ways.get(wayId)!; w.nodeIds.reverse(); });
}

export function splitWay(wayId: number, nodeId: number) {
  const d = ed().data!;
  const w = d.ways.get(wayId)!;
  const i = w.nodeIds.indexOf(nodeId);
  if (i <= 0 || i >= w.nodeIds.length - 1) return ed().toast("Это конец дороги, разрезать нельзя");
  ed().run("Разрезание дороги", [wayId], [], () => {
    const id = newId();
    d.ways.set(id, { id, nodeIds: w.nodeIds.slice(i), tags: { ...w.tags }, attrs: {} });
    w.nodeIds = w.nodeIds.slice(0, i + 1);
  });
  ed().toast("Дорога разрезана на две");
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
    if (distM(n.lat, n.lon, nlat, nlon) < 1) { ed().select({ kind: "node", id }); return ed().toast("Здесь уже есть узел"); }
  }
  // узел добавляется во все дороги, которые идут по этому же отрезку
  const a = w.nodeIds[seg.idx - 1], b = w.nodeIds[seg.idx];
  const sameSeg = [...d.ways.values()].filter((x) => x.nodeIds.some((id, i) => i > 0 && ((x.nodeIds[i - 1] === a && id === b) || (x.nodeIds[i - 1] === b && id === a))));
  let nid = 0;
  ed().run("Новый узел на дороге", sameSeg.map((x) => x.id), [], () => {
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
  if (far > JOIN_MAX_M) return ed().toast(`Узлы слишком далеко друг от друга (${Math.round(far)} м). Соединять можно ближе ${JOIN_MAX_M} м`);
  const ws = [...new Set([...waysWithNode(d, from), ...waysWithNode(d, to)])];
  ed().run("Соединение узлов", ws, [from, to], () => mergeInto(d, to, from));
  ed().select(null);
  ed().toast("Узлы соединены, дороги теперь связаны");
}

// Соединить узел с дорогой: узел ставится на ближайшую точку дороги и входит в нее
export function joinNodeToWay(from: number, wayId: number) {
  const d = ed().data!;
  const w = d.ways.get(wayId);
  const n = d.nodes.get(from);
  if (!w || !n) return;
  if (w.nodeIds.includes(from)) return ed().toast("Этот узел уже на этой дороге");
  const seg = nearestSegment(d, w, n.lat, n.lon);
  if (seg.idx < 0) return;
  // если ближайшая точка почти совпадает с узлом дороги, просто склеиваем узлы
  const [plat, plon] = seg.pr.toLatLon(seg.q[0], seg.q[1]);
  if (seg.dist > JOIN_MAX_M) return ed().toast(`Дорога слишком далеко от узла (${Math.round(seg.dist)} м). Соединять можно ближе ${JOIN_MAX_M} м`);
  for (const id of [w.nodeIds[seg.idx - 1], w.nodeIds[seg.idx]]) {
    const m = d.nodes.get(id)!;
    if (distM(m.lat, m.lon, plat, plon) < 2) return joinNodes(from, id);
  }
  ed().run("Соединение узла с дорогой", [...new Set([...waysWithNode(d, from), wayId])], [from], () => {
    n.lat = plat; n.lon = plon;
    w.nodeIds.splice(seg.idx, 0, from);
  });
  ed().select(null);
  ed().toast("Узел присоединен к дороге");
}

// Разъединить: каждая дорога, кроме первой, получает в этом месте свой узел.
// Новые узлы чуть сдвигаются вдоль своей дороги, чтобы их было видно и можно было взять мышкой.
export function unjoinNode(nodeId: number) {
  const d = ed().data!;
  const n = d.nodes.get(nodeId);
  if (!n) return;
  const ws = waysWithNode(d, nodeId);
  if (ws.length < 2) return ed().toast("В этом узле только одна дорога, разъединять нечего");
  const pr = makeProjection(n.lat, n.lon);
  ed().run("Разъединение дорог в узле", ws, [nodeId], () => {
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
  ed().toast(`Дороги в узле разъединены: ${ws.length}`);
}

export function fixError(e: GraphError) {
  const d = ed().data!;
  const pr = makeProjection(e.lat, e.lon);
  const xy = (id: number): [number, number] => { const n = d.nodes.get(id)!; return pr.toXY(n.lat, n.lon); };
  if (e.type === "torn" && e.node !== undefined && e.seg) {
    const other = d.ways.get(e.ways[1]);
    if (!other) return;
    const nodesTouched = [e.node, ...e.seg];
    const waysTouched = [...new Set([...waysWithNode(d, e.node), other.id])];
    ed().run("Соединение перекрестка", waysTouched, nodesTouched, () => {
      const [a, b] = e.seg!;
      let idx = -1;
      for (let i = 1; i < other.nodeIds.length; i++) {
        const x = other.nodeIds[i - 1], y = other.nodeIds[i];
        if ((x === a && y === b) || (x === b && y === a)) idx = i;
      }
      if (idx < 0) return;
      const pa = xy(other.nodeIds[idx - 1]), pb = xy(other.nodeIds[idx]);
      const { q } = project(xy(e.node!), pa, pb);
      if (Math.hypot(q[0] - pa[0], q[1] - pa[1]) < 0.5) mergeInto(d, other.nodeIds[idx - 1], e.node!);
      else if (Math.hypot(q[0] - pb[0], q[1] - pb[1]) < 0.5) mergeInto(d, other.nodeIds[idx], e.node!);
      else {
        const [lat, lon] = pr.toLatLon(q[0], q[1]);
        const n = d.nodes.get(e.node!)!;
        n.lat = lat; n.lon = lon;
        other.nodeIds.splice(idx, 0, e.node!);
      }
    });
  }
  if (e.type === "glued" && e.seg1 && e.seg2) {
    ed().run("Узел на пересечении", e.ways, [], () => {
      const id = newId();
      d.nodes.set(id, { id, lat: e.lat, lon: e.lon, tags: {}, attrs: {} });
      for (const [wid, sg] of [[e.ways[0], e.seg1!], [e.ways[1], e.seg2!]] as const) {
        const w = d.ways.get(wid)!;
        for (let i = 1; i < w.nodeIds.length; i++) if (w.nodeIds[i - 1] === sg[0] && w.nodeIds[i] === sg[1]) { w.nodeIds.splice(i, 0, id); break; }
      }
    });
  }
  if (e.type === "isolated") ed().run("Удален изолированный участок", e.ways, [], () => { for (const id of e.ways) d.ways.delete(id); });
  if (e.type === "attr") {
    const w = d.ways.get(e.ways[0])!;
    ed().run("Атрибуты по умолчанию", [w.id], [], () => {
      if (!w.tags.lanes) w.tags.lanes = w.tags.highway === "primary" ? "4" : "2";
      if (!w.tags.maxspeed) w.tags.maxspeed = "60";
    });
  }
  if (e.type === "bridge") ed().run("layer=1 для моста", e.ways, [], () => { d.ways.get(e.ways[0])!.tags.layer = "1"; });
}
