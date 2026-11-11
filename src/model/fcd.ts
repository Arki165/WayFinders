// Загрузка результатов SUMO: файл fcd.xml с сервера проверки.
// В fcd.xml каждую секунду записано, где едет каждая машина: полоса (lane) и скорость.
// Полоса SUMO называется по дороге OSM: "80402426#0_1" или "-80402426#0_1" (обратное направление).
// По этим записям для каждой дороги считаем:
//   N - сколько разных машин проехало по дороге за час, авт/ч;
//   V - средняя скорость на дороге (среднее по всем секундным записям, включая стоянку в пробке);
//   T факт = длина / V, мин. Это значения для таблицы «Расчеты и графики».
import type { OsmData } from "../osm/types";
import { isDrivable } from "./roads";
import { wayLengthM } from "./geo";

export interface FcdWay { cars: number; speed: number; samples: number } // speed в км/ч
export interface FcdResult { ways: Map<number, FcdWay>; hours: number }

export function readFcd(text: string): FcdResult {
  const cars = new Map<number, Set<string>>();
  const sum = new Map<number, { speed: number; n: number }>();
  let first = -1, last = -1;
  // идем по тегам по порядку: timestep задает время, vehicle - запись о машине
  for (const m of text.matchAll(/<(timestep|vehicle)\s([^>]*)>/g)) {
    const attrs = m[2];
    if (m[1] === "timestep") {
      const t = Number(/time="([\d.]+)"/.exec(attrs)?.[1]);
      if (first < 0) first = t;
      last = t;
      continue;
    }
    const lane = /lane="([^"]+)"/.exec(attrs)?.[1];
    // ":..." - полосы внутри перекрестка, их не считаем
    const way = lane ? /^-?(\d+)/.exec(lane) : null;
    if (!way) continue;
    const id = Number(way[1]);
    const veh = /\sid="([^"]+)"/.exec(" " + attrs)?.[1] ?? "";
    const speed = Number(/speed="([\d.-]+)"/.exec(attrs)?.[1] ?? 0);
    if (!cars.has(id)) { cars.set(id, new Set()); sum.set(id, { speed: 0, n: 0 }); }
    cars.get(id)!.add(veh);
    const s = sum.get(id)!;
    s.speed += Math.max(0, speed);
    s.n++;
  }
  // длительность записи в часах (у прогона сервера это ровно 1 час)
  const hours = Math.max((last - first + 1) / 3600, 1 / 60);
  const ways = new Map<number, FcdWay>();
  for (const [id, set] of cars) {
    const s = sum.get(id)!;
    ways.set(id, { cars: set.size, speed: (s.speed / s.n) * 3.6, samples: s.n });
  }
  return { ways, hours };
}

// Замеры для таблицы: N и T факт по каждой проезжей дороге графа, по которой ехали машины
export function fcdMeasures(data: OsmData, r: FcdResult): { id: number; N: number; T: number }[] {
  const out: { id: number; N: number; T: number }[] = [];
  for (const [id, f] of r.ways) {
    const w = data.ways.get(id);
    if (!w || !isDrivable(w)) continue;
    if (f.samples < 5) continue; // машина мелькнула на 1-2 секунды - по такому скорость не посчитать
    const L = wayLengthM(data, w) / 1000;
    // совсем стоящий поток: скорость не ниже 1 км/ч, чтобы время не стало бесконечным
    const T = (L / Math.max(f.speed, 1)) * 60;
    out.push({ id, N: Math.round(f.cars / r.hours), T: Math.round(T * 1000) / 1000 });
  }
  return out;
}
