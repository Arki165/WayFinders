// Диаграммы транспортного потока: модельные кривые для участка и точки по замерам.
// Модель Гриншилдса: скорость падает линейно с плотностью, V = Vсвоб × (1 - q / qзат).
// Плотность затора qзат подобрана так, чтобы максимум потока равнялся пропускной способности P:
// Nmax = Vсвоб × qзат / 4 = P, отсюда qзат = 4P / Vсвоб.
// Задержка от загрузки - формула BPR (Бюро дорог США): T = Tсвоб × (1 + 0,15 Z⁴).
import type { CalcResult } from "./calc";
import { tr } from "../i18n";

export type FlowKind = "Nq" | "Vq" | "DZ" | "VN" | "Dq" | "Tt";
export const FLOW_TITLES: Record<FlowKind, string> = {
  get Nq() { return tr("Основная диаграмма: интенсивность от плотности N(q)"); },
  get Vq() { return tr("Скорость от плотности V ср(q)"); },
  get DZ() { return tr("Задержка от загрузки D(Z)"); },
  get VN() { return tr("Скорость от интенсивности V ср(N)"); },
  get Dq() { return tr("Задержка от плотности D(q)"); },
  get Tt() { return tr("Задержка в течение суток T зад(t)"); },
};
export const FLOW_SHORT: Record<FlowKind, string> = { Nq: "N(q)", Vq: "V(q)", DZ: "D(Z)", VN: "V(N)", Dq: "D(q)", get Tt() { return tr("T зад(t)"); } };
export const FLOW_AXES: Record<FlowKind, [string, string]> = {
  Nq: ["Плотность q, авт/км", "Интенсивность N, авт/ч"],
  Vq: ["Плотность q, авт/км", "Средняя скорость V ср, км/ч"],
  DZ: ["Коэффициент загрузки Z", "Относительная задержка D, %"],
  VN: ["Интенсивность N, авт/ч", "Средняя скорость V ср, км/ч"],
  Dq: ["Плотность q, авт/км", "Относительная задержка D, %"],
  Tt: ["Час суток", "Время задержки T зад, с"],
};

const BPR_A = 0.15, BPR_B = 4;
const STEPS = 48;

// Доля часа от суточного движения в типовом городе, % (утренний пик 8 ч, вечерний 17 ч)
export const DAY_PROFILE = [0.8, 0.5, 0.4, 0.4, 0.6, 1.5, 3.5, 6.5, 8.0, 6.5, 5.5, 5.3, 5.4, 5.5, 5.6, 6.0, 7.0, 8.2, 7.8, 6.0, 4.5, 3.5, 2.6, 1.6];

export type Pt = { x: number; y: number };

// Модельная кривая для участка c
export function flowCurve(kind: FlowKind, c: CalcResult): Pt[] {
  const Vf = c.Vfree, P = c.P;
  if (!(Vf > 0 && P > 0)) return [];
  const qj = (4 * P) / Vf;
  const out: Pt[] = [];
  const range = (a: number, b: number, f: (x: number) => number | null) => {
    for (let i = 0; i <= STEPS; i++) { const x = a + ((b - a) * i) / STEPS, y = f(x); if (y !== null && isFinite(y)) out.push({ x, y }); }
  };
  if (kind === "Nq") range(0, qj, (q) => Vf * q * (1 - q / qj));
  if (kind === "Vq") range(0, qj, (q) => Vf * (1 - q / qj));
  if (kind === "DZ") range(0, 1.3, (z) => BPR_A * z ** BPR_B * 100);
  // устойчивая ветвь: до пропускной способности скорость от Vсвоб падает до Vсвоб / 2
  if (kind === "VN") range(0, P, (n) => (Vf / 2) * (1 + Math.sqrt(Math.max(0, 1 - n / P))));
  // задержка растет до бесконечности у плотности затора, график обрезаем на 90% qзат
  if (kind === "Dq") range(0, qj * 0.9, (q) => (1 / (1 - q / qj) - 1) * 100);
  if (kind === "Tt") {
    // интенсивность в час пик: замер N (считаем его пиковым), иначе типовые 85% пропускной способности
    const peak = c.N ?? 0.85 * P, top = Math.max(...DAY_PROFILE);
    // есть замер задержки - кривая проходит через него в час пик (по BPR задержка растет как Z⁴), иначе чистая BPR
    const measured = c.N !== null && c.Tdelay !== null && c.Tdelay > 0 ? c.Tdelay * 60 : null;
    DAY_PROFILE.forEach((share, h) => {
      const k = share / top, z = (peak * k) / P;
      out.push({ x: h, y: measured !== null ? measured * k ** BPR_B : c.Tfree * 60 * BPR_A * z ** BPR_B });
    });
  }
  return out;
}

// Точка участка по замерам (null, если замера для этой диаграммы нет)
export function flowPoint(kind: FlowKind, c: CalcResult): Pt | null {
  const ok = (x: number | null, y: number | null) => (x !== null && y !== null && isFinite(x) && isFinite(y) ? { x, y } : null);
  if (kind === "Nq") return ok(c.q, c.N);
  if (kind === "Vq") return ok(c.q, c.Vavg);
  if (kind === "DZ") return ok(c.Z, c.D);
  if (kind === "VN") return ok(c.N, c.Vavg);
  if (kind === "Dq") return ok(c.q, c.D);
  return null;
}
