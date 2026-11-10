// Поиск ошибок графа: разрывы, пересечения без узла, изолированные куски,
// ловушки по направлениям, пустые атрибуты, мосты без layer
import type { OsmData, OsmRelation } from "../osm/types";
import { isDrivable } from "./roads";
import { makeProjection, project } from "./geo";
import { buildingIndex, wayThroughBuilding } from "./buildings";

// ---------- граница города ----------
// Город из OSM скачивается по своей границе (Dialogs.tsx кладет ее в файл как отношение boundary=administrative).
// Дороги, уходящие за границу, обрезаны: их продолжение не скачано. Это не ошибка карты,
// поэтому все, что за границей или ближе EDGE_M к ней, считаем краем данных, как край прямоугольника.
const EDGE_M = 25;
const CLIP_BAND = 100, CLIP_CELL = 100; // полосы для подсчета пересечений и клетки для расстояния до границы, м

interface Clip {
  toXY: (lat: number, lon: number) => [number, number];
  segs: [number, number, number, number][]; // отрезки границы в метрах
  bands: Map<number, number[]>; // полоса по y -> отрезки, которые ее пересекают
  cells: Map<string, number[]>; // клетка -> отрезки ближе EDGE_M к ней
  box: [number, number, number, number]; // рамка границы с запасом
}

// Граница строится один раз на отношение: проверка графа запускается после каждой правки
const clipCache = new WeakMap<OsmRelation, Clip | null>();

function buildClip(data: OsmData, r: OsmRelation): Clip | null {
  const outer = r.members.filter((m) => m.type === "way" && (m.role === "outer" || m.role === ""));
  if (!outer.length) return null;
  const lines: [number, number][][] = [];
  for (const m of outer) {
    const w = data.ways.get(m.ref);
    // граница неполная (например, обрезана файлом) - по ней судить нельзя
    if (!w || w.nodeIds.length < 2) return null;
    lines.push(w.nodeIds.map((id) => { const n = data.nodes.get(id)!; return [n.lat, n.lon]; }));
  }
  let lat0 = 0, lon0 = 0, k = 0;
  for (const l of lines) for (const [la, lo] of l) { lat0 += la; lon0 += lo; k++; }
  const pr = makeProjection(lat0 / k, lon0 / k);
  const segs: Clip["segs"] = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) {
    const a = pr.toXY(l[i - 1][0], l[i - 1][1]), b = pr.toXY(l[i][0], l[i][1]);
    segs.push([a[0], a[1], b[0], b[1]]);
  }
  const bands = new Map<number, number[]>(), cells = new Map<string, number[]>();
  const put = <K,>(m: Map<K, number[]>, key: K, i: number) => { const c = m.get(key); if (c) c.push(i); else m.set(key, [i]); };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  segs.forEach(([ax, ay, bx, by], i) => {
    x0 = Math.min(x0, ax, bx); x1 = Math.max(x1, ax, bx); y0 = Math.min(y0, ay, by); y1 = Math.max(y1, ay, by);
    for (let b = Math.floor(Math.min(ay, by) / CLIP_BAND); b <= Math.floor(Math.max(ay, by) / CLIP_BAND); b++) put(bands, b, i);
    // клетки вдоль отрезка с запасом EDGE_M (по точкам через 20 м, чтобы длинный отрезок не занял миллион клеток)
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 20));
    const seen = new Set<string>();
    for (let j = 0; j <= steps; j++) {
      const x = ax + ((bx - ax) * j) / steps, y = ay + ((by - ay) * j) / steps;
      for (const dx of [-EDGE_M - 10, EDGE_M + 10]) for (const dy of [-EDGE_M - 10, EDGE_M + 10]) {
        const key = Math.floor((x + dx) / CLIP_CELL) + ":" + Math.floor((y + dy) / CLIP_CELL);
        if (!seen.has(key)) { seen.add(key); put(cells, key, i); }
      }
    }
  });
  return { toXY: pr.toXY, segs, bands, cells, box: [x0 - EDGE_M, y0 - EDGE_M, x1 + EDGE_M, y1 + EDGE_M] };
}

// Точка внутри границы и дальше EDGE_M от нее
function insideClip(c: Clip, lat: number, lon: number): boolean {
  const [px, py] = c.toXY(lat, lon);
  if (px < c.box[0] || px > c.box[2] || py < c.box[1] || py > c.box[3]) return false;
  for (const i of c.cells.get(Math.floor(px / CLIP_CELL) + ":" + Math.floor(py / CLIP_CELL)) ?? []) {
    const s = c.segs[i];
    if (project([px, py], [s[0], s[1]], [s[2], s[3]]).d < EDGE_M) return false;
  }
  // луч вправо: нечетное число пересечений с границей - точка внутри
  let inside = false;
  for (const i of c.bands.get(Math.floor(py / CLIP_BAND)) ?? []) {
    const [ax, ay, bx, by] = c.segs[i];
    if (ay > py !== by > py && px < ax + ((py - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  }
  return inside;
}

// Наименьший id в списке. Циклом, а не Math.min(...ids): после «соединения карт»
// отдельный кусок может быть в сотни тысяч узлов, и Math.min с таким списком переполняет стек.
function minId(ids: number[]): number {
  let m = Infinity;
  for (const id of ids) if (id < m) m = id;
  return m;
}

// Все целые границы городов в файле (после «соединения карт» их может быть несколько)
function cityClips(data: OsmData): Clip[] {
  const out: Clip[] = [];
  for (const r of data.relations.values()) {
    if (r.tags.boundary !== "administrative" || (r.tags.type !== "boundary" && r.tags.type !== "multipolygon")) continue;
    if (!clipCache.has(r)) clipCache.set(r, buildClip(data, r));
    const c = clipCache.get(r);
    if (c) out.push(c);
  }
  return out;
}

export type Severity = "danger" | "warn" | "info";
export type ErrorType = "torn" | "glued" | "isolated" | "trap" | "attr" | "bridge" | "building";

export interface GraphError {
  key: string;
  type: ErrorType;
  sev: Severity;
  lat: number;
  lon: number;
  ways: number[];
  // подробности для исправления
  node?: number;
  seg?: [number, number];
  seg1?: [number, number];
  seg2?: [number, number];
  dist?: number;
  count?: number;
  edge?: boolean;
  miss?: string[];
}

export interface ValidationResult {
  errors: GraphError[];
  nodes: number; // узлов в графе дорог
  sccMain: number; // узлов в главной сильной компоненте
  components: number;
}

export function validate(data: OsmData, ignored: Set<string> = new Set()): ValidationResult {
  const b = data.bounds;
  const lat0 = b ? (b.minlat + b.maxlat) / 2 : 0, lon0 = b ? (b.minlon + b.maxlon) / 2 : 0;
  const pr = makeProjection(lat0, lon0);
  const [bx0, by1] = b ? pr.toXY(b.minlat, b.minlon) : [0, 0];
  const [bx1, by0] = b ? pr.toXY(b.maxlat, b.maxlon) : [0, 0];
  const inBox = (p: [number, number]) => !b || (p[0] > bx0 + 25 && p[0] < bx1 - 25 && p[1] > by0 + 25 && p[1] < by1 - 25);
  // край данных: край прямоугольника или, если город скачан по границе, сама граница города
  const clips = cityClips(data);
  const inside = (p: [number, number]) => {
    if (!inBox(p)) return false;
    if (!clips.length) return true;
    const [lat, lon] = toLL(p);
    return clips.some((c) => insideClip(c, lat, lon));
  };

  const P = new Map<number, [number, number]>();
  const xy = (id: number) => {
    let p = P.get(id);
    if (!p) { const n = data.nodes.get(id)!; p = pr.toXY(n.lat, n.lon); P.set(id, p); }
    return p;
  };
  const toLL = (p: [number, number]) => pr.toLatLon(p[0], p[1]);

  const roads = [...data.ways.values()].filter((w) => isDrivable(w) && w.nodeIds.length >= 2);
  const deg = new Map<number, number>(), wayOf = new Map<number, number[]>();
  const segs: [number, number, number, string][] = [];
  const parent = new Map<number, number>();
  const find = (x: number): number => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const unite = (a: number, c: number) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(c)) parent.set(c, c); const ra = find(a), rc = find(c); if (ra !== rc) parent.set(ra, rc); };
  const adj = new Map<number, number[]>(), und = new Map<number, number[]>();
  const addE = (m: Map<number, number[]>, a: number, c: number) => { if (!m.has(a)) m.set(a, []); m.get(a)!.push(c); };

  for (const w of roads) {
    const lay = w.tags.layer || "0", ow = w.tags.oneway, rnd = w.tags.junction === "roundabout";
    w.nodeIds.forEach((id, i) => {
      // у узла список дорог; одна дорога может пройти через узел дважды (кольцо), повтор не нужен
      const list = wayOf.get(id);
      if (!list) wayOf.set(id, [w.id]); else if (list[list.length - 1] !== w.id) list.push(w.id);
      if (i === 0) return;
      const a = w.nodeIds[i - 1];
      deg.set(id, (deg.get(id) || 0) + 1); deg.set(a, (deg.get(a) || 0) + 1);
      segs.push([w.id, a, id, lay]);
      unite(a, id); addE(und, a, id); addE(und, id, a);
      if (ow === "-1") addE(adj, id, a);
      else { addE(adj, a, id); if (ow !== "yes" && ow !== "1" && !rnd) addE(adj, id, a); }
    });
  }
  const errors: GraphError[] = [];
  const center = (ids: number[]) => { let x = 0, y = 0; for (const id of ids) { const p = xy(id); x += p[0]; y += p[1]; } return toLL([x / ids.length, y / ids.length]); };
  const waysOf = (ids: number[]) => [...new Set(ids.flatMap((id) => wayOf.get(id) ?? []))];

  // 1. Изолированные куски (компоненты связности)
  const comps = new Map<number, number[]>();
  for (const id of parent.keys()) { const r = find(id); if (!comps.has(r)) comps.set(r, []); comps.get(r)!.push(id); }
  const compList = [...comps.values()].sort((a, c) => c.length - a.length);
  const mainWeak = new Set(compList[0] ?? []);
  for (const comp of compList.slice(1)) {
    const edge = !comp.every((id) => inside(xy(id)));
    const [lat, lon] = center(comp);
    errors.push({ key: "iso:" + minId(comp), type: "isolated", sev: edge ? "info" : "danger", lat, lon, ways: waysOf(comp), count: comp.length, edge });
  }

  // сетка отрезков для быстрого поиска соседей
  // Короткий отрезок кладем во все клетки его рамки (так быстрее). У длинного (дорога между городами)
  // рамка - это миллионы клеток и программа падала, поэтому его клетки берем только вдоль линии:
  // точки через 10 м, запас 17 м = 12 м поиска + половина шага.
  const CELL = 40, STEP = 10, PAD = 17, grid = new Map<number, number[]>();
  // номер клетки одним числом: город меньше 4000 км, клеток по 40 м с каждой стороны хватает
  const cellKey = (gx: number, gy: number) => (gx + 50000) * 100000 + (gy + 50000);
  const put = (k: number, i: number) => { const c = grid.get(k); if (c) c.push(i); else grid.set(k, [i]); };
  // координаты концов отрезков в одном массиве: x1, y1, x2, y2 подряд (так быстрее, чем искать узел каждый раз)
  const sxy = new Float64Array(segs.length * 4);
  segs.forEach((s, i) => {
    const a = xy(s[1]), c = xy(s[2]);
    sxy[i * 4] = a[0]; sxy[i * 4 + 1] = a[1]; sxy[i * 4 + 2] = c[0]; sxy[i * 4 + 3] = c[1];
    const gx0 = Math.floor((Math.min(a[0], c[0]) - 12) / CELL), gx1 = Math.floor((Math.max(a[0], c[0]) + 12) / CELL);
    const gy0 = Math.floor((Math.min(a[1], c[1]) - 12) / CELL), gy1 = Math.floor((Math.max(a[1], c[1]) + 12) / CELL);
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) <= 64) {
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) put(cellKey(gx, gy), i);
      return;
    }
    const steps = Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / STEP);
    const cells = new Set<number>();
    for (let j = 0; j <= steps; j++) {
      const x = a[0] + ((c[0] - a[0]) * j) / steps, y = a[1] + ((c[1] - a[1]) * j) / steps;
      for (const dx of [-PAD, PAD]) for (const dy of [-PAD, PAD]) cells.add(cellKey(Math.floor((x + dx) / CELL), Math.floor((y + dy) / CELL)));
    }
    for (const k of cells) put(k, i);
  });

  // 2. Разорванные перекрестки: конец дороги ближе 12 м к другой дороге, но не соединен
  for (const w of roads) {
    for (const end of [w.nodeIds[0], w.nodeIds[w.nodeIds.length - 1]]) {
      const p = xy(end);
      if (deg.get(end) !== 1 || !inside(p)) continue;
      // тупик у закрытых ворот или шлагбаума - так задумано, проезда там нет
      const et = data.nodes.get(end)!.tags;
      if (et.barrier && (et.access === "no" || et.access === "private" || et.motor_vehicle === "no")) continue;
      let best: { d: number; s: [number, number, number, string] } | null = null;
      for (const i of grid.get(cellKey(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL))) ?? []) {
        const s = segs[i];
        if (s[0] === w.id || s[1] === end || s[2] === end) continue;
        const { d } = project(p, xy(s[1]), xy(s[2]));
        if (d < 12 && (!best || d < best.d)) best = { d, s };
      }
      if (best) {
        const n = data.nodes.get(end)!;
        errors.push({ key: "torn:" + end, type: "torn", sev: "danger", lat: n.lat, lon: n.lon, ways: [w.id, best.s[0]], node: end, seg: [best.s[1], best.s[2]], dist: best.d });
      }
    }
  }

  // 3. Пересечение на одном уровне без общего узла
  const seen = new Set<string>();
  for (const cell of grid.values()) {
    for (let i = 0; i < cell.length; i++) for (let j = i + 1; j < cell.length; j++) {
      const i1 = cell[i] * 4, i2 = cell[j] * 4;
      // быстрая проверка: рамки отрезков не перекрываются - пересечения точно нет
      if (Math.max(sxy[i1], sxy[i1 + 2]) < Math.min(sxy[i2], sxy[i2 + 2]) || Math.max(sxy[i2], sxy[i2 + 2]) < Math.min(sxy[i1], sxy[i1 + 2])) continue;
      if (Math.max(sxy[i1 + 1], sxy[i1 + 3]) < Math.min(sxy[i2 + 1], sxy[i2 + 3]) || Math.max(sxy[i2 + 1], sxy[i2 + 3]) < Math.min(sxy[i1 + 1], sxy[i1 + 3])) continue;
      const s1 = segs[cell[i]], s2 = segs[cell[j]];
      if (s1[0] === s2[0] || s1[3] !== s2[3]) continue;
      if (s1[1] === s2[1] || s1[1] === s2[2] || s1[2] === s2[1] || s1[2] === s2[2]) continue;
      const p1 = [sxy[i1], sxy[i1 + 1]], p2 = [sxy[i1 + 2], sxy[i1 + 3]], p3 = [sxy[i2], sxy[i2 + 1]], p4 = [sxy[i2 + 2], sxy[i2 + 3]];
      const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
      if (Math.abs(d) < 1e-9) continue;
      const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
      const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
      if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) {
        // ключ пары дорог собираем только для найденного пересечения: одна ошибка на пару
        const pk = Math.min(s1[0], s2[0]) + ":" + Math.max(s1[0], s2[0]);
        if (seen.has(pk)) continue;
        seen.add(pk);
        const [lat, lon] = toLL([p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])]);
        errors.push({ key: "glued:" + pk, type: "glued", sev: "danger", lat, lon, ways: [s1[0], s2[0]], seg1: [s1[1], s1[2]], seg2: [s2[1], s2[2]] });
      }
    }
  }

  // 4. Сильная связность по направлениям (алгоритм Тарьяна без рекурсии)
  const ids = [...parent.keys()];
  let index = 0;
  const idx = new Map<number, number>(), low = new Map<number, number>(), on = new Set<number>(), stack: number[] = [], sccs: number[][] = [];
  for (const s0 of ids) {
    if (idx.has(s0)) continue;
    const work: [number, number][] = [[s0, 0]];
    idx.set(s0, index); low.set(s0, index); index++; stack.push(s0); on.add(s0);
    while (work.length) {
      const fr = work[work.length - 1], v = fr[0], nb = adj.get(v) ?? [];
      if (fr[1] < nb.length) {
        const w2 = nb[fr[1]++];
        if (!idx.has(w2)) { idx.set(w2, index); low.set(w2, index); index++; stack.push(w2); on.add(w2); work.push([w2, 0]); }
        else if (on.has(w2)) low.set(v, Math.min(low.get(v)!, idx.get(w2)!));
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u)!, low.get(v)!)); }
        if (low.get(v) === idx.get(v)) { const comp: number[] = []; let x: number; do { x = stack.pop()!; on.delete(x); comp.push(x); } while (x !== v); sccs.push(comp); }
      }
    }
  }
  sccs.sort((a, c) => c.length - a.length);
  const mainS = new Set(sccs[0] ?? []);
  const trap = new Set(ids.filter((id) => !mainS.has(id) && mainWeak.has(id) && inside(xy(id))));
  const done = new Set<number>();
  for (const s0 of trap) {
    if (done.has(s0)) continue;
    const comp: number[] = [], q = [s0];
    done.add(s0);
    while (q.length) { const v = q.pop()!; comp.push(v); for (const w2 of und.get(v) ?? []) if (trap.has(w2) && !done.has(w2)) { done.add(w2); q.push(w2); } }
    if (comp.length < 3) continue;
    const [lat, lon] = center(comp);
    errors.push({ key: "trap:" + minId(comp), type: "trap", sev: "warn", lat, lon, ways: waysOf(comp), count: comp.length });
  }

  // 5. Атрибуты у крупных улиц, мосты без уровня, дороги сквозь здания
  const bix = buildingIndex(data);
  for (const w of roads) {
    const mid = data.nodes.get(w.nodeIds[Math.floor(w.nodeIds.length / 2)])!;
    if (["primary", "secondary", "tertiary", "trunk"].includes(w.tags.highway)) {
      const miss = ["lanes", "maxspeed"].filter((k) => !w.tags[k]);
      if (miss.length) errors.push({ key: "attr:" + w.id, type: "attr", sev: "info", lat: mid.lat, lon: mid.lon, ways: [w.id], miss });
    }
    if (w.tags.bridge === "yes" && !w.tags.layer) errors.push({ key: "bridge:" + w.id, type: "bridge", sev: "warn", lat: mid.lat, lon: mid.lon, ways: [w.id] });
    // в Webots машина проедет сквозь стену, а в жизни такой дороги нет
    const hit = wayThroughBuilding(data, bix, w);
    if (hit) errors.push({ key: "building:" + w.id, type: "building", sev: "danger", lat: hit.at.lat, lon: hit.at.lon, ways: [w.id, hit.b.id] });
  }

  return { errors: errors.filter((e) => !ignored.has(e.key)), nodes: ids.length, sccMain: mainS.size, components: compList.length };
}
