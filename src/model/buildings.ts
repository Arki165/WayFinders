// Здания и дороги: дорога не должна проходить сквозь дом, а мост над домом должен быть выше крыши.
// Только чтение данных, граф не меняется.
import type { OsmData, OsmWay } from "../osm/types";
import { isDrivable } from "./roads";

const M_LAT = 111320;
type Pt = [number, number]; // x = долгота × cos(широты), y = широта (в градусах, но в одном масштабе)
export interface Building { id: number; poly: Pt[]; h: number; x0: number; y0: number; x1: number; y1: number }

// Высота здания, м: тег height, иначе этажи × 3 м, иначе 3 этажа
export function buildingHeight(w: OsmWay): number {
  const h = parseFloat(w.tags.height ?? "");
  if (h > 0) return h;
  const lv = parseFloat(w.tags["building:levels"] ?? "");
  return (lv > 0 ? lv : 3) * 3;
}

// Дорога, которой можно проходить через здание: мост, тоннель, проезд под домом (арка), другой уровень
export function mayCrossBuildings(w: OsmWay): boolean {
  const t = w.tags;
  return t.bridge === "yes" || !!t.tunnel || t.covered === "yes" || (!!t.layer && t.layer !== "0") || t.location === "underground";
}

// Сетка зданий: по клетке быстро находим, какие здания рядом
const CELL = 0.0008;
export interface BuildingIndex { k: number; grid: Map<string, Building[]> }

export function buildingIndex(data: OsmData): BuildingIndex {
  const b = data.bounds;
  const k = Math.cos((((b ? (b.minlat + b.maxlat) / 2 : 52)) * Math.PI) / 180);
  const grid = new Map<string, Building[]>();
  for (const w of data.ways.values()) {
    if (!w.tags.building || w.tags.building === "no" || w.nodeIds.length < 4) continue;
    const poly: Pt[] = [];
    for (const id of w.nodeIds) { const n = data.nodes.get(id); if (n) poly.push([n.lon * k, n.lat]); }
    if (poly.length < 4) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const bl: Building = { id: w.id, poly, h: buildingHeight(w), x0, y0, x1, y1 };
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        const key = gx + ":" + gy, c = grid.get(key);
        if (c) c.push(bl); else grid.set(key, [bl]);
      }
  }
  return { k, grid };
}

function inside(p: Pt, poly: Pt[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

// Здания, сквозь которые проходит отрезок a-b (lat, lon). Концы отрезка в пределах 0,7 м от края не считаются:
// дорога может упираться в стену или выходить из арки.
export function buildingsOnSegment(ix: BuildingIndex, a: { lat: number; lon: number }, b: { lat: number; lon: number }): Building[] {
  const pa: Pt = [a.lon * ix.k, a.lat], pb: Pt = [b.lon * ix.k, b.lat];
  const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) * M_LAT;
  if (len < 0.01) return [];
  const cand = new Set<Building>();
  const steps = Math.max(1, Math.ceil(len / 40));
  for (let s = 0; s <= steps; s++) {
    const x = pa[0] + ((pb[0] - pa[0]) * s) / steps, y = pa[1] + ((pb[1] - pa[1]) * s) / steps;
    for (const bl of ix.grid.get(Math.floor(x / CELL) + ":" + Math.floor(y / CELL)) ?? []) cand.add(bl);
  }
  const out: Building[] = [];
  const n = Math.max(2, Math.ceil(len / 1.5)), edge = Math.min(0.45, 0.7 / len);
  for (const bl of cand) {
    if (Math.max(pa[0], pb[0]) < bl.x0 || Math.min(pa[0], pb[0]) > bl.x1 || Math.max(pa[1], pb[1]) < bl.y0 || Math.min(pa[1], pb[1]) > bl.y1) continue;
    for (let i = 0; i <= n; i++) {
      const t = edge + ((1 - 2 * edge) * i) / n;
      if (inside([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t], bl.poly)) { out.push(bl); break; }
    }
  }
  return out;
}

// Здание, внутри которого стоит точка
export function buildingAt(ix: BuildingIndex, p: { lat: number; lon: number }): Building | null {
  const q: Pt = [p.lon * ix.k, p.lat];
  for (const bl of ix.grid.get(Math.floor(q[0] / CELL) + ":" + Math.floor(q[1] / CELL)) ?? []) if (inside(q, bl.poly)) return bl;
  return null;
}

// Первое здание, сквозь которое проходит дорога (или null). Мосты, тоннели и арки пропускаются.
export function wayThroughBuilding(data: OsmData, ix: BuildingIndex, w: OsmWay): { b: Building; at: { lat: number; lon: number } } | null {
  if (!isDrivable(w) || mayCrossBuildings(w)) return null;
  for (let i = 1; i < w.nodeIds.length; i++) {
    const a = data.nodes.get(w.nodeIds[i - 1]), c = data.nodes.get(w.nodeIds[i]);
    if (!a || !c) continue;
    const hit = buildingsOnSegment(ix, a, c)[0];
    if (hit) return { b: hit, at: { lat: (a.lat + c.lat) / 2, lon: (a.lon + c.lon) / 2 } };
  }
  return null;
}

// Самое высокое здание под мостом, м (0, если под мостом зданий нет)
export function tallestUnder(data: OsmData, ix: BuildingIndex, w: OsmWay): number {
  let h = 0;
  for (let i = 1; i < w.nodeIds.length; i++) {
    const a = data.nodes.get(w.nodeIds[i - 1]), c = data.nodes.get(w.nodeIds[i]);
    if (a && c) for (const bl of buildingsOnSegment(ix, a, c)) h = Math.max(h, bl.h);
  }
  return h;
}
