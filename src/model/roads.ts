// Справочник дорог: классы, покрытия, скорости, светофоры
import type { OsmData, OsmNode, OsmWay } from "../osm/types";

export interface RoadClass {
  ru: string;
  color: [number, number, number];
  lanes: number; // полос по умолчанию, если тег lanes не задан
  rank: number; // порядок отрисовки: важные дороги сверху
}

export const ROAD_CLASSES: Record<string, RoadClass> = {
  motorway: { ru: "Автомагистраль", color: [226, 110, 80], lanes: 4, rank: 12 },
  trunk: { ru: "Скоростная дорога", color: [232, 132, 90], lanes: 4, rank: 11 },
  primary: { ru: "Магистральная улица", color: [240, 180, 69], lanes: 4, rank: 10 },
  secondary: { ru: "Районная улица", color: [244, 220, 131], lanes: 2, rank: 9 },
  tertiary: { ru: "Местная улица", color: [250, 240, 190], lanes: 2, rank: 8 },
  motorway_link: { ru: "Съезд", color: [226, 110, 80], lanes: 1, rank: 7 },
  trunk_link: { ru: "Съезд", color: [232, 132, 90], lanes: 1, rank: 7 },
  primary_link: { ru: "Съезд", color: [240, 180, 69], lanes: 1, rank: 7 },
  secondary_link: { ru: "Съезд", color: [244, 220, 131], lanes: 1, rank: 7 },
  tertiary_link: { ru: "Съезд", color: [250, 240, 190], lanes: 1, rank: 7 },
  unclassified: { ru: "Улица без класса", color: [235, 235, 230], lanes: 2, rank: 6 },
  residential: { ru: "Жилая улица", color: [235, 235, 230], lanes: 2, rank: 5 },
  living_street: { ru: "Жилая зона", color: [210, 225, 210], lanes: 1, rank: 4 },
  service: { ru: "Проезд", color: [205, 205, 200], lanes: 1, rank: 3 },
};

// Дороги, по которым ездят машины. Только они идут в проверки и расчеты.
export const isDrivable = (w: OsmWay) => w.tags.highway !== undefined && w.tags.highway in ROAD_CLASSES && w.tags.area !== "yes";

export const roadClass = (w: OsmWay): RoadClass => ROAD_CLASSES[w.tags.highway] ?? ROAD_CLASSES.service;

// Покрытие дороги и коэффициент снижения скорости (условные значения, уточняют транспортники)
export const SURFACES: Record<string, { ru: string; k: number }> = {
  asphalt: { ru: "Асфальт", k: 1.0 },
  concrete: { ru: "Бетон", k: 1.0 },
  paving_stones: { ru: "Плитка", k: 0.8 },
  sett: { ru: "Брусчатка", k: 0.7 },
  compacted: { ru: "Укатанный щебень", k: 0.75 },
  fine_gravel: { ru: "Мелкий гравий", k: 0.65 },
  gravel: { ru: "Гравий", k: 0.6 },
  unpaved: { ru: "Без покрытия", k: 0.5 },
  ground: { ru: "Грунт", k: 0.5 },
  dirt: { ru: "Грунтовка", k: 0.5 },
  sand: { ru: "Песок", k: 0.4 },
};

// Скорость по умолчанию, если maxspeed не задан (городские нормы РФ)
const DEFAULT_SPEED: Record<string, number> = { motorway: 110, trunk: 90, living_street: 20, service: 20, residential: 40 };

export function maxSpeed(w: OsmWay): number {
  const m = w.tags.maxspeed;
  if (m && /^\d+/.test(m)) return parseInt(m, 10);
  if (m === "RU:urban") return 60;
  if (m === "RU:rural") return 90;
  if (m === "RU:living_street") return 20;
  return DEFAULT_SPEED[w.tags.highway] ?? 60;
}

export function lanesOf(w: OsmWay): number {
  const n = parseInt(w.tags.lanes ?? "", 10);
  return n > 0 ? n : roadClass(w).lanes;
}

export const isOneway = (w: OsmWay) => w.tags.oneway === "yes" || w.tags.oneway === "1" || w.tags.oneway === "-1" || w.tags.junction === "roundabout";

// Светофор для машин: узел с highway=traffic_signals, который лежит на проезжей дороге.
// Железнодорожные сигналы (railway=signal) и светофоры на тротуарах не считаем.
export function drivableNodeSet(data: OsmData): Set<number> {
  const s = new Set<number>();
  for (const w of data.ways.values()) if (isDrivable(w)) for (const id of w.nodeIds) s.add(id);
  return s;
}

// Регулируемый пешеходный переход (crossing=traffic_signals) - тоже светофор для машин
export function isSignalTagged(n: OsmNode): boolean {
  return n.tags.highway === "traffic_signals" || n.tags.crossing === "traffic_signals";
}

export function isRoadSignal(n: OsmNode, onRoad: Set<number>): boolean {
  return isSignalTagged(n) && onRoad.has(n.id);
}

// Время работы светофора храним в своих тегах: в OSM стандартного тега для фаз нет
export const SIGNAL_KEYS = { cycle: "wayfinders:cycle", green: "wayfinders:green", yellow: "wayfinders:yellow", red: "wayfinders:red" };

export function wayName(w: OsmWay | undefined): string {
  if (!w) return "дорога";
  return w.tags.name || roadClass(w).ru;
}
