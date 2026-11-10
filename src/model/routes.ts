// Маршруты общественного транспорта из OpenStreetMap: автобус, троллейбус, трамвай, маршрутка.
// В OSM маршрут - это отношение (relation) type=route: в нем по порядку дороги, по которым едет
// транспорт, и остановки (роль stop или platform). Номер маршрута - тег ref, цвет - colour.
import { create } from "zustand";
import type { OsmData, OsmRelation } from "../osm/types";
import { distM } from "./geo";

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
  const name = (t.from && t.to ? `${t.from} - ${t.to}` : (t.name ?? "").replace(/^[^:]*:\s*/, "").replace(/\s*=>\s*/g, " - ")) || "Без названия";
  return { id: r.id, kind: t.route, ref: t.ref ?? "?", name, color: parseColor(t.colour) ?? ROUTE_COLOR[t.route], ways, stops, missing, lengthM };
}

// Все маршруты файла: по виду транспорта, затем по номеру (2, 10, 10к, 45)
export function listRoutes(data: OsmData): Route[] {
  const out: Route[] = [];
  for (const r of data.relations.values()) { const x = toRoute(data, r); if (x && x.ways.length) out.push(x); }
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

// Какой маршрут выбран в списке (показывается на карте)
export const useRoute = create<{ id: number | null; set: (id: number | null) => void }>((set) => ({ id: null, set: (id) => set({ id }) }));

// Один маршрут по id отношения (или null, если его уже нет)
export function getRoute(data: OsmData, id: number): Route | null {
  const r = data.relations.get(id);
  return r ? toRoute(data, r) : null;
}
