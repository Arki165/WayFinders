// Геометрия: расстояния в метрах по координатам
import type { OsmData, OsmWay } from "../osm/types";

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function wayLengthM(data: OsmData, w: OsmWay): number {
  let s = 0;
  for (let i = 1; i < w.nodeIds.length; i++) {
    const a = data.nodes.get(w.nodeIds[i - 1]), b = data.nodes.get(w.nodeIds[i]);
    if (a && b) s += distM(a.lat, a.lon, b.lat, b.lon);
  }
  return s;
}

// Плоская проекция в метрах вокруг центра карты (для проверок на малом участке ее хватает)
export function makeProjection(lat0: number, lon0: number) {
  const kx = Math.cos(rad(lat0)) * 111320, ky = 110540;
  return {
    toXY: (lat: number, lon: number): [number, number] => [(lon - lon0) * kx, (lat0 - lat) * ky],
    toLatLon: (x: number, y: number): [number, number] => [lat0 - y / ky, lon0 + x / kx],
  };
}

// Ближайшая точка на отрезке ab к точке p (все в метрах)
export function project(p: [number, number], a: [number, number], b: [number, number]): { q: [number, number]; t: number; d: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
  const q: [number, number] = [a[0] + t * dx, a[1] + t * dy];
  return { q, t, d: Math.hypot(q[0] - p[0], q[1] - p[1]) };
}
