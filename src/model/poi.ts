// Объекты города для слоев карты: пешеходные переходы, остановки, метро.
// Только чтение данных, граф не меняется.
import { nameOf } from "../i18n";
import type { OsmData, OsmNode, OsmWay } from "../osm/types";
import { isDrivable } from "./roads";
import { roadWidth } from "./lanes";

export type PoiKind = "crossing" | "bus" | "tram" | "train" | "metro" | "entrance";
export interface Poi { id: number; pos: [number, number]; kind: PoiKind; name: string }

const isMetroStation = (t: OsmNode["tags"]) =>
  (t.railway === "station" && (t.station === "subway" || t.subway === "yes")) || (t.public_transport === "station" && t.subway === "yes");

// Вид объекта по тегам узла или null, если это не наш объект
export function poiKind(n: OsmNode): PoiKind | null {
  const t = n.tags;
  if (isMetroStation(t)) return "metro";
  if (t.railway === "subway_entrance") return "entrance";
  // остановку трамвая часто ставят прямо на рельсы, отдельной платформы нет
  if (t.railway === "tram_stop") return "tram";
  // место остановки поезда или автобуса на линии - служебная точка, ее не показываем (есть платформа или станция)
  if (t.public_transport === "stop_position") return null;
  // переход со светофором показывает слой светофоров
  if ((t.highway === "crossing" || t.footway === "crossing") && t.crossing !== "traffic_signals") return "crossing";
  if (t.highway === "bus_stop" || (t.public_transport === "platform" && (t.bus === "yes" || t.trolleybus === "yes"))) return "bus";
  if (t.railway === "station" || t.railway === "halt" || t.railway === "stop") return "train";
  return null;
}

export function cityPois(data: OsmData): Poi[] {
  const out: Poi[] = [];
  // место остановки трамвая на рельсах (stop_position) показываем, только если рядом нет платформы:
  // иначе одна остановка видна двумя значками «Т»
  const stopPos: Poi[] = [];
  for (const n of data.nodes.values()) {
    const kind = poiKind(n);
    if (!kind) continue;
    const p: Poi = { id: n.id, pos: [n.lon, n.lat], kind, name: nameOf(n.tags) };
    if (kind === "tram" && n.tags.public_transport === "stop_position") stopPos.push(p); else out.push(p);
  }
  const platforms = out.filter((p) => p.kind === "tram");
  const near = (a: Poi, b: Poi) => Math.hypot((a.pos[0] - b.pos[0]) * Math.cos((a.pos[1] * Math.PI) / 180), a.pos[1] - b.pos[1]) * M_LAT < 60;
  for (const s of stopPos) if (!platforms.some((p) => near(p, s) && (!p.name || !s.name || p.name === s.name))) out.push(s);
  return out;
}

// ---------- метро ----------
export interface MetroLine { id: number; path: [number, number][]; color: [number, number, number]; tunnel: boolean }

// Сколько линий метро в файле: по маршрутам (без «туда» и «обратно»), а если маршрутов нет - по цветам участков
export function metroLineCount(data: OsmData, lines: MetroLine[]): number {
  const names = new Set<string>();
  for (const r of data.relations.values()) {
    if (r.tags.route !== "subway") continue;
    names.add((r.tags.ref || r.tags.colour || r.tags.name?.split(":")[0] || String(r.id)).trim());
  }
  if (names.size) return names.size;
  return new Set(lines.map((l) => l.color.join(","))).size;
}

// Цвет линии в OSM пишут кодом (#d7282f) или словом (red)
const NAMED: Record<string, [number, number, number]> = {
  red: [215, 40, 40], green: [40, 160, 70], blue: [30, 110, 200], lightblue: [80, 180, 230], yellow: [245, 190, 20],
  orange: [240, 130, 30], brown: [140, 90, 50], purple: [140, 60, 160], violet: [140, 60, 160], grey: [140, 140, 140], gray: [140, 140, 140], pink: [230, 110, 160],
};
function hexColor(v: string | undefined): [number, number, number] | null {
  const s = v?.trim().toLowerCase() ?? "";
  if (NAMED[s]) return NAMED[s];
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  const m = /^#?([0-9a-f]{6})$/.exec(s);
  if (!m) return null;
  const x = parseInt(m[1], 16);
  return [(x >> 16) & 255, (x >> 8) & 255, x & 255];
}

export const isMetroWay = (w: OsmWay) => w.tags.railway === "subway";

// Линии метро. Цвет берем из маршрута (relation route=subway, тег colour) или из самой линии.
export function metroLines(data: OsmData): MetroLine[] {
  const colorOf = new Map<number, [number, number, number]>();
  for (const r of data.relations.values()) {
    if (r.tags.route !== "subway") continue;
    const c = hexColor(r.tags.colour);
    if (c) for (const m of r.members) if (m.type === "way" && !colorOf.has(m.ref)) colorOf.set(m.ref, c);
  }
  const out: MetroLine[] = [];
  for (const w of data.ways.values()) {
    if (!isMetroWay(w) || w.nodeIds.length < 2) continue;
    const path = w.nodeIds.map((id) => data.nodes.get(id)).filter(Boolean).map((n) => [n!.lon, n!.lat] as [number, number]);
    out.push({ id: w.id, path, color: hexColor(w.tags.colour) ?? colorOf.get(w.id) ?? [215, 40, 40], tunnel: w.tags.tunnel === "yes" || w.tags.layer?.startsWith("-") === true });
  }
  return out;
}

// ---------- «зебра» на проезжей части ----------
const M_LAT = 111320;

// Полосы зебры для переходов, которые лежат на проезжей дороге: вдоль движения, поперек всей ширины
export function zebras(data: OsmData, pois: Poi[]): [number, number][][] {
  const crossIds = new Set(pois.filter((p) => p.kind === "crossing").map((p) => p.id));
  for (const n of data.nodes.values()) if (n.tags.crossing === "traffic_signals") crossIds.add(n.id);
  const out: [number, number][][] = [];
  if (!crossIds.size) return out;
  const done = new Set<number>();
  for (const w of data.ways.values()) {
    if (!isDrivable(w)) continue;
    const ids = w.nodeIds;
    for (let i = 0; i < ids.length; i++) {
      if (!crossIds.has(ids[i]) || done.has(ids[i])) continue;
      const n = data.nodes.get(ids[i]), a = data.nodes.get(ids[Math.max(0, i - 1)]), b = data.nodes.get(ids[Math.min(ids.length - 1, i + 1)]);
      if (!n || !a || !b || a === b) continue;
      done.add(ids[i]);
      const k = Math.cos((n.lat * Math.PI) / 180) * M_LAT;
      let dx = (b.lon - a.lon) * k, dy = (b.lat - a.lat) * M_LAT;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const W = roadWidth(w);
      // полоса 0,5 м через 0,5 м, длина 3 м вдоль дороги
      for (let o = -W / 2 + 0.5; o <= W / 2 - 0.25; o += 1) {
        const cx = -dy * o, cy = dx * o;
        out.push([
          [n.lon + (cx - dx * 1.5) / k, n.lat + (cy - dy * 1.5) / M_LAT],
          [n.lon + (cx + dx * 1.5) / k, n.lat + (cy + dy * 1.5) / M_LAT],
        ]);
      }
    }
  }
  return out;
}

// Зона пешей доступности остановки: среднее из норматива (автобус и троллейбус 300-400 м, трамвай 400-600 м)
export const WALK_RADIUS: Partial<Record<PoiKind, number>> = { bus: 350, tram: 500 };

// Радиус зоны для узла-остановки или null, если узел не остановка
export function walkRadius(n: OsmNode): number | null {
  const k = poiKind(n);
  return k ? WALK_RADIUS[k] ?? null : null;
}
