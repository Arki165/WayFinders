// Расчеты загрузки участка по формулам транспортников
import type { OsmData, OsmWay } from "../osm/types";
import { lanesOf, maxSpeed, SURFACES } from "./roads";
import { wayLengthM } from "./geo";

// Нормативы, которые можно менять в программе (значения условные, уточняют транспортники)
export interface Norms {
  laneCapacity: Record<string, number>; // пропускная способность одной полосы, авт/ч
  surfaceK: Record<string, number>; // коэффициент скорости по покрытию
  z1: number; // порог "умеренно"
  z2: number; // порог "загружено"
  z3: number; // порог "перегружено"
}

export const DEFAULT_NORMS: Norms = {
  laneCapacity: { motorway: 1800, trunk: 1500, primary: 900, secondary: 800, tertiary: 700, unclassified: 550, residential: 500, living_street: 300, service: 300, link: 700 },
  surfaceK: Object.fromEntries(Object.entries(SURFACES).map(([k, v]) => [k, v.k])),
  z1: 0.5,
  z2: 0.7,
  z3: 0.9,
};

// Замеры храним в тегах дороги, чтобы они сохранялись в .osm вместе с правками
export const MEASURE_KEYS = { volume: "wayfinders:volume", time: "wayfinders:travel_time" };

export interface CalcResult {
  L: number; // длина, км
  Vmax: number; // разрешенная скорость, км/ч
  kSurface: number; // коэффициент покрытия
  Vfree: number; // скорость свободного движения, км/ч
  Tfree: number; // время свободного проезда, мин
  lanes: number;
  P: number; // пропускная способность, авт/ч
  N: number | null; // интенсивность, авт/ч (замер)
  Tfact: number | null; // фактическое время, мин (замер)
  Z: number | null; // коэффициент загрузки
  Vavg: number | null; // средняя скорость, км/ч
  q: number | null; // плотность, авт/км
  Tdelay: number | null; // время задержки, мин
  D: number | null; // относительная задержка, %
}

export function capacityPerLane(w: OsmWay, norms: Norms): number {
  const h = w.tags.highway ?? "service";
  if (h.endsWith("_link")) return norms.laneCapacity.link;
  return norms.laneCapacity[h] ?? norms.laneCapacity.service;
}

export function surfaceK(w: OsmWay, norms: Norms): number {
  const s = w.tags.surface;
  if (!s) return 1;
  return norms.surfaceK[s] ?? 1;
}

export function calcWay(data: OsmData, w: OsmWay, norms: Norms): CalcResult {
  const L = wayLengthM(data, w) / 1000;
  const Vmax = maxSpeed(w);
  const kSurface = surfaceK(w, norms);
  // Скорость свободного движения учитывает покрытие: по грунтовке быстро не поедешь
  const Vfree = Vmax * kSurface;
  // T своб считается отдельно, только из длины и свободной скорости
  const Tfree = Vfree > 0 ? (L / Vfree) * 60 : 0;
  const lanes = lanesOf(w);
  const P = lanes * capacityPerLane(w, norms);

  const N = w.tags[MEASURE_KEYS.volume] ? Number(w.tags[MEASURE_KEYS.volume]) : null;
  const Tfact = w.tags[MEASURE_KEYS.time] ? Number(w.tags[MEASURE_KEYS.time]) : null;

  const Z = N !== null && P > 0 ? N / P : null;
  const Vavg = Tfact !== null && Tfact > 0 ? L / (Tfact / 60) : null;
  const q = N !== null && Vavg ? N / Vavg : null;
  const Tdelay = Tfact !== null ? Tfact - Tfree : null;
  const D = Tdelay !== null && Tfree > 0 ? (Tdelay / Tfree) * 100 : null;

  return { L, Vmax, kSurface, Vfree, Tfree, lanes, P, N, Tfact, Z, Vavg, q, Tdelay, D };
}

export function zLevel(z: number, norms: Norms): 0 | 1 | 2 | 3 {
  return z < norms.z1 ? 0 : z < norms.z2 ? 1 : z < norms.z3 ? 2 : 3;
}
export const Z_TEXT = ["свободно", "умеренно", "загружено", "перегружено"];
export const Z_COLORS: [number, number, number][] = [[63, 157, 90], [168, 185, 52], [229, 154, 40], [216, 64, 47]];
