// Маршруты общественного транспорта из OpenStreetMap: автобус, троллейбус, трамвай, маршрутка.
// В OSM маршрут - это отношение (relation) type=route: в нем по порядку дороги, по которым едет
// транспорт, и остановки (роль stop или platform). Номер маршрута - тег ref, цвет - colour.
import { create } from "zustand";
import type { OsmData, OsmNode, OsmRelation, Tags } from "../osm/types";
import { distM } from "./geo";
import { batch, newId, runRelation, setNodeTags, useEditor } from "./store";
import { tr } from "../i18n";

export type RouteKind = "bus" | "trolleybus" | "tram" | "share_taxi";
export const ROUTE_KINDS: RouteKind[] = ["bus", "trolleybus", "tram", "share_taxi"];
export const ROUTE_RU: Record<RouteKind, string> = { get bus() { return tr("Автобус"); }, get trolleybus() { return tr("Троллейбус"); }, get tram() { return tr("Трамвай"); }, get share_taxi() { return tr("Маршрутка"); } };
// цвет по виду транспорта, если в OSM у маршрута нет своего цвета
export const ROUTE_COLOR: Record<RouteKind, [number, number, number]> = { bus: [46, 158, 79], trolleybus: [31, 111, 209], tram: [214, 48, 49], share_taxi: [230, 140, 30] };

export interface Route {
  id: number;
  kind: RouteKind;
  ref: string; // номер маршрута
  name: string; // «от - до» или название
  color: [number, number, number];
  ways: number[]; // дороги маршрута, которые есть в файле
  stops: number[]; // остановки по порядку, которые есть в файле
  missing: number; // сколько частей маршрута нет в файле (обрезано краем карты)
  custom: boolean; // свой маршрут, нарисованный в программе
  lengthM: number;
}

const isRouteKind = (s: string | undefined): s is RouteKind => !!s && (ROUTE_KINDS as string[]).includes(s);

// цвет из тега colour: #rrggbb или #rgb
function parseColor(c: string | undefined): [number, number, number] | null {
  const m = c?.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((x) => x + x).join("") : m[1];
  const c3: [number, number, number] = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  // почти черный или почти белый цвет не виден на темной или светлой карте: берем цвет вида транспорта
  const light = 0.3 * c3[0] + 0.59 * c3[1] + 0.11 * c3[2];
  return light < 50 || light > 215 ? null : c3;
}

function toRoute(data: OsmData, r: OsmRelation): Route | null {
  const t = r.tags;
  if (t.type !== "route" || !isRouteKind(t.route)) return null;
  const ways: number[] = [], stops: number[] = [];
  let missing = 0, lengthM = 0;
  for (const m of r.members) {
    if (m.type === "way" && !/platform/.test(m.role)) {
      const w = data.ways.get(m.ref);
      if (!w) { missing++; continue; }
      ways.push(w.id);
      for (let i = 1; i < w.nodeIds.length; i++) {
        const a = data.nodes.get(w.nodeIds[i - 1]), b = data.nodes.get(w.nodeIds[i]);
        if (a && b) lengthM += distM(a.lat, a.lon, b.lat, b.lon);
      }
    } else if (m.type === "node" && /stop|platform/.test(m.role)) {
      // у одной остановки бывает и место остановки на дороге (рельсах), и платформа: показываем платформу.
      // Место остановки пропускаем, только если платформа этой же остановки есть в файле: в выгрузке часто
      // у одних остановок есть только платформа, у других только место остановки (так было у трамвая)
      const n = data.nodes.get(m.ref);
      if (!n) continue;
      if (m.role.startsWith("stop") && r.members.some((x) => x.type === "node" && x.role.startsWith("platform") && sameStop(n, data.nodes.get(x.ref)))) continue;
      if (!stops.includes(m.ref)) stops.push(m.ref);
    }
  }
  // название: «Автобус 16: Центр => Аэропорт» - берем часть после двоеточия, иначе from - to
  const custom = t[CUSTOM_KEY] === "yes";
  const name = (t.from && t.to ? `${t.from} - ${t.to}` : custom ? "" : (t.name ?? "").replace(/^[^:]*:\s*/, "").replace(/\s*=>\s*/g, " - ")) || (custom ? tr("Остановки еще не выбраны") : tr("Без названия"));
  return { id: r.id, kind: t.route, ref: t.ref ?? "?", name, color: parseColor(t.colour) ?? ROUTE_COLOR[t.route], ways, stops, missing, lengthM, custom };
}

// Все маршруты файла: по виду транспорта, затем по номеру (2, 10, 10к, 45)
export function listRoutes(data: OsmData): Route[] {
  const out: Route[] = [];
  // маршруты, у которых в файле нет ни одной дороги, не показываем; свой новый маршрут показываем и пустым
  for (const r of data.relations.values()) { const x = toRoute(data, r); if (x && (x.ways.length || x.custom)) out.push(x); }
  const num = (s: string) => parseInt(s, 10) || 9999;
  return out.sort((a, b) => ROUTE_KINDS.indexOf(a.kind) - ROUTE_KINDS.indexOf(b.kind) || num(a.ref) - num(b.ref) || a.ref.localeCompare(b.ref, "ru") || a.name.localeCompare(b.name, "ru"));
}

// Платформа и место остановки - одна остановка: рядом друг с другом и с одним названием (или без названия)
const SAME_STOP_M = 80;
export function sameStop(a: OsmNode | undefined, b: OsmNode | undefined): boolean {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (a.tags.name && b.tags.name && a.tags.name !== b.tags.name) return false;
  return distM(a.lat, a.lon, b.lat, b.lon) < SAME_STOP_M;
}

// Маршруты, которые останавливаются на этой остановке: узел записан в маршруте остановкой или платформой,
// либо в маршруте записана вторая половина этой же остановки (платформа к месту остановки и наоборот)
export function routesAtNode(data: OsmData, nodeId: number): Route[] {
  const node = data.nodes.get(nodeId);
  if (!node) return [];
  const ids = new Set<number>();
  for (const r of data.relations.values()) {
    if (r.tags.type !== "route" || !isRouteKind(r.tags.route)) continue;
    if (r.members.some((m) => m.type === "node" && /stop|platform/.test(m.role) && sameStop(node, data.nodes.get(m.ref)))) ids.add(r.id);
  }
  return listRoutes(data).filter((r) => ids.has(r.id));
}

// ---------- остановки ----------
// Теги остановки по виду транспорта (схема OSM public_transport v2: платформа рядом с дорогой)
const STOP_KEYS = ["highway", "railway", "public_transport", "bus", "trolleybus", "tram", "share_taxi"];
export function stopTags(kind: RouteKind, name: string): Tags {
  const t: Tags = kind === "tram" ? { railway: "tram_stop", public_transport: "platform", tram: "yes" } : { highway: "bus_stop", public_transport: "platform", bus: "yes" };
  if (kind === "trolleybus") t.trolleybus = "yes";
  if (kind === "share_taxi") t.share_taxi = "yes";
  if (name.trim()) t.name = name.trim();
  return t;
}
// Вид остановки по тегам (для переключателя в панели узла)
export function stopKindOf(t: Tags): RouteKind {
  if (t.railway === "tram_stop" || t.tram === "yes") return "tram";
  if (t.trolleybus === "yes") return "trolleybus";
  if (t.share_taxi === "yes") return "share_taxi";
  return "bus";
}

// Новая остановка-платформа в точке (lat, lon). routeId - сразу добавить в этот маршрут.
// Одна правка в истории: отмена убирает и остановку, и ее место в маршруте
export function createStop(kind: RouteKind, lat: number, lon: number, name: string, routeId: number | null): number {
  const d = useEditor.getState().data;
  if (!d) return 0;
  const id = newId();
  const label = tr("Новая остановка") + (name.trim() ? " " + tr("«{0}»", name.trim()) : "");
  batch(label, () => {
    useEditor.getState().run(label, [], [], () => { d.nodes.set(id, { id, lat, lon, tags: stopTags(kind, name), attrs: {} }); });
    if (routeId !== null && d.relations.has(routeId)) toggleRouteStop(routeId, id, "platform");
  });
  return id;
}

// Название и вид остановки. Свои маршруты через эту остановку получают новое название начала или конца
export function setStop(nodeId: number, kind: RouteKind, name: string) {
  const d = useEditor.getState().data;
  const n = d?.nodes.get(nodeId);
  if (!d || !n) return;
  const t: Tags = { ...n.tags };
  // вид меняем, только если он другой: иначе теги из OSM (например, место остановки на рельсах) остаются как есть
  if (stopKindOf(t) !== kind || !Object.keys(t).some((k) => STOP_KEYS.includes(k))) {
    for (const k of STOP_KEYS) delete t[k];
    Object.assign(t, stopTags(kind, ""));
  }
  if (name.trim()) t.name = name.trim(); else delete t.name;
  batch(tr("Остановка"), () => {
    setNodeTags(nodeId, t, tr("Остановка"));
    for (const r of d.relations.values()) {
      if (r.tags[CUSTOM_KEY] !== "yes" || !r.members.some((m) => m.type === "node" && m.ref === nodeId)) continue;
      runRelation(tr("Маршрут ") + (r.tags.ref ?? ""), r.id, (dd) => renameRoute(dd, dd.relations.get(r.id)!));
    }
  });
}

// При разрезании дороги новая половина тоже входит во все маршруты исходной дороги,
// сразу после нее (или перед ней, если маршрут идет по дороге в обратную сторону - порядок не важен для показа).
export function copyRouteMembership(data: OsmData, fromWay: number, newWay: number) {
  for (const r of data.relations.values()) {
    if (r.tags.type !== "route") continue;
    const i = r.members.findIndex((m) => m.type === "way" && m.ref === fromWay);
    if (i >= 0) r.members.splice(i + 1, 0, { type: "way", ref: newWay, role: r.members[i].role });
  }
}

// Какой маршрут выбран в списке (показывается на карте) и правим ли мы его сейчас
// placing - ждем клика по карте, куда поставить новую остановку (строка - ее название)
export const useRoute = create<{ id: number | null; editing: boolean; placing: string | null; set: (id: number | null) => void; edit: (on: boolean) => void; place: (name: string | null) => void }>((set) => ({
  id: null, editing: false, placing: null,
  set: (id) => set({ id, editing: false, placing: null }),
  edit: (editing) => set({ editing, placing: null }),
  place: (placing) => set({ placing }),
}));

// ---------- свои маршруты ----------
// Отметка своего маршрута в файле (теги wayfinders:* программа уже использует для замеров)
export const CUSTOM_KEY = "wayfinders:custom";

// Начало и конец своего маршрута - названия первой и последней остановки, название маршрута из них.
// Так их не нужно вводить руками, и они всегда совпадают с тем, что нарисовано.
function renameRoute(d: OsmData, r: OsmRelation) {
  const names = r.members.filter((m) => m.type === "node").map((m) => d.nodes.get(m.ref)?.tags.name).filter(Boolean) as string[];
  const kind = isRouteKind(r.tags.route) ? r.tags.route : "bus";
  const t = { ...r.tags };
  delete t.from; delete t.to;
  if (names.length >= 2) { t.from = names[0]; t.to = names[names.length - 1]; }
  // название пишется в файл OSM, поэтому всегда по-русски, на каком бы языке ни был интерфейс
  const KIND_RU: Record<RouteKind, string> = { bus: "Автобус", trolleybus: "Троллейбус", tram: "Трамвай", share_taxi: "Маршрутка" };
  t.name = `${KIND_RU[kind]} ${t.ref ?? ""}` + (t.from ? `: ${t.from} => ${t.to}` : "");
  r.tags = t;
}

export function createRoute(kind: RouteKind, ref: string): number {
  const id = newId();
  runRelation(tr("Новый маршрут ") + ref, id, (d) => {
    const r: OsmRelation = { id, members: [], attrs: {}, tags: { type: "route", route: kind, ref, "public_transport:version": "2", [CUSTOM_KEY]: "yes" } };
    renameRoute(d, r);
    d.relations.set(id, r);
  });
  useRoute.getState().set(id);
  useRoute.getState().edit(true);
  return id;
}

// Вид транспорта и номер
export function setRouteInfo(id: number, kind: RouteKind, ref: string) {
  runRelation(tr("Маршрут ") + ref, id, (d) => {
    const r = d.relations.get(id);
    if (!r) return;
    r.tags = { ...r.tags, route: kind, ref };
    if (r.tags[CUSTOM_KEY] === "yes") renameRoute(d, r);
  });
}

// Клик по дороге в режиме правки: дорога добавляется в конец маршрута, повторный клик убирает ее
export function toggleRouteWay(id: number, wayId: number) {
  const d = useEditor.getState().data;
  const r = d?.relations.get(id);
  if (!r) return;
  const has = r.members.some((m) => m.type === "way" && m.ref === wayId);
  runRelation(has ? tr("Дорога убрана из маршрута") : tr("Дорога добавлена в маршрут"), id, (dd) => {
    const x = dd.relations.get(id)!;
    if (has) x.members = x.members.filter((m) => !(m.type === "way" && m.ref === wayId));
    else x.members.push({ type: "way", ref: wayId, role: "" });
  });
}

// Клик по остановке: добавить в конец списка остановок или убрать. asRole - роль для новой остановки
export function toggleRouteStop(id: number, nodeId: number, asRole?: "stop" | "platform") {
  const d = useEditor.getState().data;
  const r = d?.relations.get(id);
  if (!r) return;
  const has = r.members.some((m) => m.type === "node" && m.ref === nodeId);
  // если в маршруте остановки записаны платформами, новую тоже записываем платформой (иначе ее не будет видно)
  const role = asRole ?? (r.members.some((m) => m.type === "node" && m.role.startsWith("platform")) ? "platform" : "stop");
  runRelation(has ? tr("Остановка убрана из маршрута") : tr("Остановка добавлена в маршрут"), id, (dd) => {
    const x = dd.relations.get(id)!;
    if (has) x.members = x.members.filter((m) => !(m.type === "node" && m.ref === nodeId));
    else {
      // остановки идут в начале списка, перед дорогами (так принято в OSM)
      const firstWay = x.members.findIndex((m) => m.type === "way");
      const lastStop = x.members.reduce((k, m, i) => (m.type === "node" ? i : k), -1);
      x.members.splice(lastStop >= 0 ? lastStop + 1 : firstWay >= 0 ? firstWay : x.members.length, 0, { type: "node", ref: nodeId, role });
    }
    // у своего маршрута начало и конец - первая и последняя остановка
    if (x.tags[CUSTOM_KEY] === "yes") renameRoute(dd, x);
  });
}

export function deleteRoute(id: number) {
  runRelation(tr("Маршрут удален"), id, (d) => { d.relations.delete(id); });
  useRoute.getState().set(null);
}

// Один маршрут по id отношения (или null, если его уже нет)
export function getRoute(data: OsmData, id: number): Route | null {
  const r = data.relations.get(id);
  return r ? toRoute(data, r) : null;
}

// ---------- разрывы маршрута на карте ----------
// В OpenStreetMap маршрут иногда записан с пропуском: после правки дороги в него забыли добавить короткий кусок.
// Тогда две соседние дороги маршрута не имеют общего узла, и линия на карте рвется.
// Такой разрыв до BRIDGE_MAX_M метров закрываем кратчайшим путем по дорогам (для трамвая - по путям).
// Это только для показа: сам маршрут в файле не меняется.
const BRIDGE_MAX_M = 400;

export function routeBridges(data: OsmData, r: Route): [number, number][][] {
  const ways = r.ways.map((id) => data.ways.get(id)).filter((w): w is NonNullable<typeof w> => !!w && w.nodeIds.length > 1);
  // сначала ищем разрывы: чаще всего их нет, и строить граф не нужно
  const gaps: [number[], Set<number>][] = [];
  for (let i = 1; i < ways.length; i++) {
    const a = ways[i - 1], b = ways[i];
    if (a.nodeIds.some((id) => b.nodeIds.includes(id))) continue;
    gaps.push([[a.nodeIds[0], a.nodeIds[a.nodeIds.length - 1]], new Set([b.nodeIds[0], b.nodeIds[b.nodeIds.length - 1]])]);
  }
  if (!gaps.length) return [];
  // граф: узел -> соседи с расстоянием. Трамвай идет по путям, остальные по дорогам
  const fits = (t: Record<string, string>) => (r.kind === "tram" ? t.railway === "tram" : !!t.highway && t.area !== "yes" && !/^(footway|path|steps|cycleway|pedestrian)$/.test(t.highway));
  const adj = new Map<number, [number, number][]>();
  const link = (x: number, y: number, m: number) => { const l = adj.get(x); if (l) l.push([y, m]); else adj.set(x, [[y, m]]); };
  for (const w of data.ways.values()) {
    if (!fits(w.tags)) continue;
    for (let i = 1; i < w.nodeIds.length; i++) {
      const a = data.nodes.get(w.nodeIds[i - 1]), b = data.nodes.get(w.nodeIds[i]);
      if (!a || !b) continue;
      const m = distM(a.lat, a.lon, b.lat, b.lon);
      link(a.id, b.id, m); link(b.id, a.id, m);
    }
  }
  const out: [number, number][][] = [];
  for (const [from, to] of gaps) {
    // поиск кратчайшего пути от концов первой дороги до концов второй, не дальше BRIDGE_MAX_M
    const dist = new Map<number, number>(from.map((id) => [id, 0])), prev = new Map<number, number>();
    const open = new Set(from);
    let hit: number | null = null;
    while (open.size) {
      let cur = -1, best = Infinity;
      for (const id of open) { const v = dist.get(id)!; if (v < best) { best = v; cur = id; } }
      open.delete(cur);
      if (to.has(cur)) { hit = cur; break; }
      for (const [nb, m] of adj.get(cur) ?? []) {
        const v = best + m;
        if (v > BRIDGE_MAX_M || v >= (dist.get(nb) ?? Infinity)) continue;
        dist.set(nb, v); prev.set(nb, cur); open.add(nb);
      }
    }
    if (hit === null) continue;
    const path: [number, number][] = [];
    for (let id: number | undefined = hit; id !== undefined; id = prev.get(id)) { const n = data.nodes.get(id)!; path.push([n.lon, n.lat]); }
    if (path.length > 1) out.push(path);
  }
  return out;
}
