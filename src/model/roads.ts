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

// Группы классов для выбора в панели: улицы города (СП 42.13330) и дороги общего пользования вне города (ГОСТ Р 52398).
// У дорог общего пользования категория хранится в своем теге, класс OSM подбирается по ней.
export const CITY_CLASSES = ["trunk", "primary", "secondary", "tertiary", "residential", "living_street", "service", "primary_link"];
export const CATEGORY_KEY = "wayfinders:category";
// Классификация по расчетной интенсивности движения, прив. ед./сут (ГОСТ Р 52398, таблица 1)
export const ROAD_CATEGORIES: { id: string; cat: string; cls: string; ru: string; flow: string; highway: string; lanes: number; speed: number }[] = [
  { id: "IA", cat: "IА", cls: "Автомагистраль", ru: "IА, автомагистраль", flow: "свыше 14000", highway: "motorway", lanes: 4, speed: 110 },
  { id: "IB", cat: "IБ", cls: "Скоростная дорога", ru: "IБ, скоростная дорога", flow: "свыше 14000", highway: "trunk", lanes: 4, speed: 90 },
  { id: "IC", cat: "IВ", cls: "Дорога обычного типа", ru: "IВ, дорога обычного типа", flow: "свыше 14000", highway: "trunk", lanes: 4, speed: 90 },
  { id: "II", cat: "II", cls: "Дорога обычного типа", ru: "II категория", flow: "свыше 6000 для федеральных, от 6000 до 14000 для других", highway: "primary", lanes: 2, speed: 90 },
  { id: "III", cat: "III", cls: "Дорога обычного типа", ru: "III категория", flow: "свыше 2000 до 6000", highway: "secondary", lanes: 2, speed: 90 },
  { id: "IV", cat: "IV", cls: "Дорога обычного типа", ru: "IV категория", flow: "свыше 200 до 2000", highway: "tertiary", lanes: 2, speed: 70 },
  { id: "V", cat: "V", cls: "Дорога обычного типа", ru: "V категория", flow: "до 200", highway: "unclassified", lanes: 1, speed: 60 },
];
// Короткое пояснение к классу в меню выбора
export const CLASS_HINT: Record<string, string> = {
  trunk: "магистраль непрерывного движения",
  primary: "магистральная улица общегородского значения",
  secondary: "магистральная улица районного значения",
  tertiary: "улица местного значения",
  residential: "улица в жилой застройке",
  living_street: "пешеходы главнее, 20 км/ч",
  service: "проезд к домам, парковкам",
  primary_link: "съезд, поворотная связка",
  unclassified: "улица или дорога без класса",
};

// Покрытие дороги и коэффициент снижения скорости (условные значения, уточняют транспортники).
// По правилам OSM щебень записывается как gravel, гравий (галька) как pebblestone.
export const SURFACES: Record<string, { ru: string; k: number }> = {
  asphalt: { ru: "Асфальт", k: 1.0 },
  concrete: { ru: "Бетон", k: 1.0 },
  paving_stones: { ru: "Плитка", k: 0.8 },
  sett: { ru: "Брусчатка", k: 0.7 },
  gravel: { ru: "Щебень", k: 0.6 },
  compacted: { ru: "Укатанный щебень", k: 0.75 },
  fine_gravel: { ru: "Мелкий гравий", k: 0.65 },
  pebblestone: { ru: "Гравий", k: 0.6 },
  ground: { ru: "Грунт", k: 0.5 },
  sand: { ru: "Песок", k: 0.4 },
};
// Старые значения из файлов OSM: в меню их нет, но читаются как похожие покрытия
export const SURFACE_ALIAS: Record<string, string> = { dirt: "ground", unpaved: "ground", earth: "ground", mud: "ground", paved: "asphalt", "concrete:plates": "concrete" };
export const SURFACE_OTHER: Record<string, string> = { dirt: "Грунтовка", unpaved: "Без покрытия", paved: "С покрытием", wood: "Дерево", grass: "Трава" };
export const surfaceName = (v: string) => SURFACES[v]?.ru ?? SURFACE_OTHER[v] ?? v;

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
// Фазы отдельного подхода: wayfinders:green:N - зеленый для машин, которые едут с севера.
// Подход задаем стороной света, а не номером дороги: номера новых дорог меняются при сохранении.
export const phaseKey = (k: "green" | "yellow" | "red", side: string) => `${SIGNAL_KEYS[k]}:${side}`;

// Стороны света по азимуту: 0 - север, по часовой стрелке
const SIDES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const SIDES_RU = ["с севера", "с северо-востока", "с востока", "с юго-востока", "с юга", "с юго-запада", "с запада", "с северо-запада"];
export const sideOf = (az: number) => SIDES[Math.round((((az % 360) + 360) % 360) / 45) % 8];
export const sideRu = (side: string) => SIDES_RU[SIDES.indexOf(side)] ?? side;

// Азимут от точки a к точке b в градусах
export function azimuth(a: OsmNode, b: OsmNode): number {
  const dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), dy = b.lat - a.lat;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

// Рукав узла: дорога и соседний узел на ней. incoming - машины по этому рукаву въезжают в узел.
export interface Arm { wayId: number; nb: number; az: number; side: string; incoming: boolean; name: string }

export function nodeArms(data: OsmData, nodeId: number): Arm[] {
  const n = data.nodes.get(nodeId);
  if (!n) return [];
  const arms: Arm[] = [];
  for (const w of data.ways.values()) {
    if (!isDrivable(w)) continue;
    const ids = w.nodeIds;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== nodeId) continue;
      const ow = w.tags.oneway === "yes" || w.tags.oneway === "1" || w.tags.junction === "roundabout" ? 1 : w.tags.oneway === "-1" ? -1 : 0;
      // с предыдущего узла машины едут к нам, если движение не только обратное
      for (const [j, inc] of [[i - 1, ow !== -1], [i + 1, ow !== 1]] as const) {
        const nb = data.nodes.get(ids[j]);
        if (!nb || ids[j] === nodeId) continue;
        const az = azimuth(n, nb);
        arms.push({ wayId: w.id, nb: nb.id, az, side: sideOf(az), incoming: inc, name: wayName(w) });
      }
    }
  }
  return arms.sort((a, b) => a.az - b.az);
}

// Рельсовые пути: трамвай и железная дорога
export const TRACKS: Record<string, string> = { tram: "Трамвайные пути", rail: "Железная дорога", light_rail: "Легкое метро", subway: "Метро" };
export const isTrack = (w: OsmWay) => !!w.tags.railway && w.tags.railway in TRACKS;

export function wayName(w: OsmWay | undefined): string {
  if (!w) return "дорога";
  return w.tags.name || roadClass(w).ru;
}
