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

// Точки в [долгота, широта], как их рисует карта
type LL = [number, number];

// Дуга, которая плавно продолжает отрезок prev-last и приходит в точку to.
// Возвращает промежуточные точки дуги (без концов), радиус и длину в метрах.
// Если точка to лежит почти на продолжении отрезка или позади него, дуги нет: null.
export function tangentArc(prev: LL, last: LL, to: LL): { pts: LL[]; radius: number; length: number } | null {
  const kx = Math.cos(rad(last[1])) * 111320, ky = 110540;
  // все считаем в метрах от точки last
  let dx = (last[0] - prev[0]) * kx, dy = (last[1] - prev[1]) * ky;
  const dl = Math.hypot(dx, dy);
  if (dl < 0.5) return null;
  dx /= dl; dy /= dl;
  const vx = (to[0] - last[0]) * kx, vy = (to[1] - last[1]) * ky;
  const cross = dx * vy - dy * vx, dot = dx * vx + dy * vy;
  const sweep = 2 * Math.atan2(cross, dot); // угол поворота дуги: плюс - влево, минус - вправо
  if (Math.abs(sweep) < rad(3) || Math.abs(sweep) > rad(200)) return null;
  const R = (vx * vx + vy * vy) / (2 * cross); // радиус со знаком: центр слева или справа
  const cx = -dy * R, cy = dx * R; // центр окружности
  const steps = Math.min(24, Math.max(2, Math.ceil(Math.abs(sweep) / rad(10))));
  const pts: LL[] = [];
  for (let k = 1; k < steps; k++) {
    const a = (sweep * k) / steps, cos = Math.cos(a), sin = Math.sin(a);
    // поворачиваем точку last (она в нуле) вокруг центра
    const x = cx + -cx * cos - -cy * sin, y = cy + -cx * sin + -cy * cos;
    pts.push([last[0] + x / kx, last[1] + y / ky]);
  }
  return { pts, radius: Math.abs(R), length: Math.abs(R * sweep) };
}

// Угол поворота между отрезками a-b и b-c в градусах: 0 - прямо, 90 - поворот под прямым углом
export function turnAngle(a: LL, b: LL, c: LL): number {
  const k = Math.cos(rad(b[1]));
  const a1 = Math.atan2(b[1] - a[1], (b[0] - a[0]) * k), a2 = Math.atan2(c[1] - b[1], (c[0] - b[0]) * k);
  let d = Math.abs(a2 - a1) * (180 / Math.PI);
  if (d > 180) d = 360 - d;
  return d;
}
