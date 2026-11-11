// Расчеты загрузки участка по формулам транспортников
import type { OsmData, OsmWay } from "../osm/types";
import { lanesOf, maxSpeed, SURFACES, SURFACE_ALIAS } from "./roads";
import { wayLengthM } from "./geo";

// Нормативы, которые можно менять в программе (значения условные, уточняют транспортники)
export interface Norms {
  laneCapacity: Record<string, number>; // пропускная способность одной полосы, авт/ч
  friction: Record<string, number>; // коэффициент сцепления φ по покрытию, от 0,1 до 1
  z1: number; // порог "умеренно"
  z2: number; // порог "загружено"
  z3: number; // порог "перегружено"
}

export const DEFAULT_NORMS: Norms = {
  laneCapacity: { motorway: 1800, trunk: 1500, primary: 900, secondary: 800, tertiary: 700, unclassified: 550, residential: 500, living_street: 300, service: 300, link: 700 },
  friction: Object.fromEntries(Object.entries(SURFACES).map(([k, v]) => [k, v.k])),
  z1: 0.5,
  z2: 0.7,
  z3: 0.9,
};

// Нормативы запоминаются между запусками программы.
// Берем сохраненные значения поверх стандартных, чтобы новые классы и покрытия тоже были.
const NORMS_KEY = "norms";
export function loadNorms(): Norms {
  try {
    const v = JSON.parse(localStorage.getItem(NORMS_KEY) ?? "{}");
    return {
      ...DEFAULT_NORMS,
      ...v,
      laneCapacity: { ...DEFAULT_NORMS.laneCapacity, ...v.laneCapacity },
      // старые сохраненные «коэффициенты скорости» (surfaceK) не берем: это другая величина
      friction: Object.fromEntries(Object.entries({ ...DEFAULT_NORMS.friction, ...v.friction }).map(([k, x]) => [k, clampPhi(Number(x)) ?? DEFAULT_NORMS.friction[k] ?? PHI_REF])),
    };
  } catch {
    return DEFAULT_NORMS;
  }
}
export function saveNorms(n: Norms) {
  try { localStorage.setItem(NORMS_KEY, JSON.stringify(n)); } catch { /* хранилище недоступно */ }
}

// Замеры храним в тегах дороги, чтобы они сохранялись в .osm вместе с правками
export const MEASURE_KEYS = { volume: "wayfinders:volume", time: "wayfinders:travel_time" };

// ---------- коэффициент сцепления ----------
// φ берется из тега дороги wayfinders:friction (если задан у дороги), иначе из нормативов по покрытию.
// Скорость свободного движения снижается пропорционально корню из φ: допустимая скорость по условию
// сцепления (торможение, поворот) растет как √φ. Опорное значение - сухой асфальт φ₀ = 0,8: при нем скорость не снижается.
export const FRICTION_KEY = "wayfinders:friction";
export const PHI_MIN = 0.1, PHI_MAX = 1, PHI_REF = 0.8;
// число в пределах 0,1-1 (больше и меньше - к границе), не число - null
export function clampPhi(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  return Math.round(Math.min(PHI_MAX, Math.max(PHI_MIN, x)) * 1000) / 1000;
}
export function frictionOf(w: OsmWay, norms: Norms): { phi: number; from: "road" | "surface" | "default" } {
  const own = w.tags[FRICTION_KEY];
  if (own !== undefined && own.trim() !== "") { const x = clampPhi(Number(own.replace(",", "."))); if (x !== null) return { phi: x, from: "road" }; }
  const s = w.tags.surface;
  const v = s ? norms.friction[s] ?? norms.friction[SURFACE_ALIAS[s]] : undefined;
  return v !== undefined ? { phi: v, from: "surface" } : { phi: PHI_REF, from: "default" };
}
export const speedFactor = (phi: number) => Math.min(1, Math.sqrt(phi / PHI_REF));

export interface CalcResult {
  L: number; // длина, км
  Vmax: number; // разрешенная скорость, км/ч
  phi: number; // коэффициент сцепления φ
  kSurface: number; // снижение скорости по сцеплению, √(φ / φ₀), не больше 1
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

// Коэффициент снижения скорости по сцеплению (1 - не снижается)
export function surfaceK(w: OsmWay, norms: Norms): number {
  return speedFactor(frictionOf(w, norms).phi);
}

export function calcWay(data: OsmData, w: OsmWay, norms: Norms): CalcResult {
  const L = wayLengthM(data, w) / 1000;
  const Vmax = maxSpeed(w);
  const phi = frictionOf(w, norms).phi;
  const kSurface = speedFactor(phi);
  // Скорость свободного движения учитывает сцепление: по грунту, песку или льду быстро не поедешь
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

  return { L, Vmax, phi, kSurface, Vfree, Tfree, lanes, P, N, Tfact, Z, Vavg, q, Tdelay, D };
}

export function zLevel(z: number, norms: Norms): 0 | 1 | 2 | 3 {
  return z < norms.z1 ? 0 : z < norms.z2 ? 1 : z < norms.z3 ? 2 : 3;
}
export const Z_TEXT = ["свободно", "умеренно", "загружено", "перегружено"];
export const Z_COLORS: [number, number, number][] = [[63, 157, 90], [168, 185, 52], [229, 154, 40], [216, 64, 47]];
