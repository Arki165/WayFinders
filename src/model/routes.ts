// Маршруты общественного транспорта из OpenStreetMap: автобус, троллейбус, трамвай, маршрутка.
// В OSM маршрут - это отношение (relation) type=route: в нем по порядку дороги, по которым едет
// транспорт, и остановки (роль stop или platform). Номер маршрута - тег ref, цвет - colour.
import { create } from "zustand";
import type { OsmData, OsmRelation } from "../osm/types";
import { distM } from "./geo";
import { newId, runRelation, useEditor } from "./store";

export type RouteKind = "bus" | "trolleybus" | "tram" | "share_taxi";
export const ROUTE_KINDS: RouteKind[] = ["bus", "trolleybus", "tram", "share_taxi"];
export const ROUTE_RU: Record<RouteKind, string> = { bus: "Автобус", trolleybus: "Троллейбус", tram: "Трамвай", share_taxi: "Маршрутка" };
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
      // у одной остановки бывает и место остановки, и платформа: показываем платформу, если она есть
      if (!data.nodes.has(m.ref)) continue;
      if (m.role.startsWith("stop") && r.members.some((x) => x.type === "node" && x.role.startsWith("platform"))) continue;
      stops.push(m.ref);
    }
  }
  // название: «Автобус 16: Центр => Аэропорт» - берем часть после двоеточия, иначе from - to
  const custom = t[CUSTOM_KEY] === "yes";
  const name = (t.from && t.to ? `${t.from} - ${t.to}` : custom ? "" : (t.name ?? "").replace(/^[^:]*:\s*/, "").replace(/\s*=>\s*/g, " - ")) || (custom ? "Остановки еще не выбраны" : "Без названия");
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

// Маршруты, которые останавливаются на этой остановке (или проходят через этот узел)
export function routesAtNode(data: OsmData, nodeId: number): Route[] {
  return listRoutes(data).filter((r) => r.stops.includes(nodeId));
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
export const useRoute = create<{ id: number | null; editing: boolean; set: (id: number | null) => void; edit: (on: boolean) => void }>((set) => ({
  id: null, editing: false,
  set: (id) => set({ id, editing: false }),
  edit: (editing) => set({ editing }),
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
  t.name = `${ROUTE_RU[kind]} ${t.ref ?? ""}` + (t.from ? `: ${t.from} => ${t.to}` : "");
  r.tags = t;
}

export function createRoute(kind: RouteKind, ref: string): number {
  const id = newId();
  runRelation("Новый маршрут " + ref, id, (d) => {
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
  runRelation("Маршрут " + ref, id, (d) => {
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
  runRelation(has ? "Дорога убрана из маршрута" : "Дорога добавлена в маршрут", id, (dd) => {
    const x = dd.relations.get(id)!;
    if (has) x.members = x.members.filter((m) => !(m.type === "way" && m.ref === wayId));
    else x.members.push({ type: "way", ref: wayId, role: "" });
  });
}

// Клик по остановке: добавить в конец списка остановок или убрать
export function toggleRouteStop(id: number, nodeId: number) {
  const d = useEditor.getState().data;
  const r = d?.relations.get(id);
  if (!r) return;
  const has = r.members.some((m) => m.type === "node" && m.ref === nodeId);
  // если в маршруте остановки записаны платформами, новую тоже записываем платформой (иначе ее не будет видно)
  const role = r.members.some((m) => m.type === "node" && m.role.startsWith("platform")) ? "platform" : "stop";
  runRelation(has ? "Остановка убрана из маршрута" : "Остановка добавлена в маршрут", id, (dd) => {
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
  runRelation("Маршрут удален", id, (d) => { d.relations.delete(id); });
  useRoute.getState().set(null);
}

// Один маршрут по id отношения (или null, если его уже нет)
export function getRoute(data: OsmData, id: number): Route | null {
  const r = data.relations.get(id);
  return r ? toRoute(data, r) : null;
}
