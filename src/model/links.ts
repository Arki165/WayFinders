// Связи полос на перекрестке: с какой полосы подъезда на какую полосу выезда можно проехать.
// Считается по стрелкам поворота на полосах (turn:lanes). Если стрелки не заданы, с полосы можно ехать во все стороны.
// Только чтение данных, граф не меняется.
import type { OsmData, OsmWay } from "../osm/types";
import { isDrivable } from "./roads";
import { getLanes, laneWidth, roadWidth } from "./lanes";

export type LinkKind = "left" | "through" | "right";
export interface LaneLink { path: [number, number][]; kind: LinkKind }

// Полоса на рукаве перекрестка: смещение вправо по ходу движения (м) и разрешенные повороты
interface ArmLane { t: number; turn: string }
// Рукав: направление от узла наружу (единичный вектор в метрах) и полосы подъезда и выезда
interface Arm { ux: number; uy: number; len: number; way: OsmWay; inc: ArmLane[]; out: ArmLane[] }

// К какому виду относится поворот из тега: slight_left тоже налево и так далее
const turnKind = (t: string): LinkKind | null => (t.includes("left") ? "left" : t.includes("right") ? "right" : t === "through" ? "through" : null);

export function laneLinks(data: OsmData, nodeId: number): LaneLink[] {
  const n = data.nodes.get(nodeId);
  if (!n) return [];
  const kx = Math.cos((n.lat * Math.PI) / 180) * 111320, ky = 110540;
  const arms: Arm[] = [];
  for (const w of data.ways.values()) {
    if (!isDrivable(w)) continue;
    const ids = w.nodeIds;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== nodeId) continue;
      const lanes = getLanes(w), widths = lanes.map(laneWidth);
      const W = widths.reduce((s, x) => s + x, 0);
      // середина каждой полосы поперек дороги: минус - слева от линии дороги, плюс - справа
      let edge = -W / 2;
      const mids = widths.map((x) => { edge += x; return edge - x / 2; });
      // рукав к предыдущему узлу (линия дороги идет к нам) и к следующему (линия уходит от нас)
      for (const [j, toNode] of [[i - 1, true], [i + 1, false]] as const) {
        const nb = data.nodes.get(ids[j]);
        if (!nb || nb === n) continue;
        const dx = (nb.lon - n.lon) * kx, dy = (nb.lat - n.lat) * ky, len = Math.hypot(dx, dy);
        if (len < 1) continue;
        const inc: ArmLane[] = [], out: ArmLane[] = [];
        lanes.forEach((l, q) => {
          if (l.kind === "bicycle") return;
          // полоса едет к узлу, если ее направление совпадает с тем, как линия дороги подходит к узлу
          const incoming = (l.dir === "forward") === toNode;
          // смещение вправо по ходу движения: у полос «обратно» право и лево меняются местами
          const t = l.dir === "forward" ? mids[q] : -mids[q];
          (incoming ? inc : out).push({ t, turn: l.turn });
        });
        inc.sort((a, b) => a.t - b.t);
        out.sort((a, b) => a.t - b.t);
        arms.push({ ux: dx / len, uy: dy / len, len, way: w, inc, out });
      }
    }
  }
  // обычный узел посреди дороги перекрестком не считаем
  if (arms.length < 3) return [];
  const widest = Math.max(...arms.map((a) => roadWidth(a.way)));
  const links: LaneLink[] = [];
  const ll = (x: number, y: number): [number, number] => [n.lon + x / kx, n.lat + y / ky];
  for (const a of arms) {
    if (!a.inc.length) continue;
    const setA = Math.min(widest / 2 + 3, a.len * 0.8);
    a.inc.forEach((lane, li) => {
      // какие повороты разрешены с этой полосы: пусто - любые
      const allowed = lane.turn ? lane.turn.split(";").map(turnKind) : null;
      for (const b of arms) {
        if (b === a || !b.out.length) continue;
        // едем к узлу по направлению -a.u, уезжаем по b.u: угол между ними и есть поворот
        const ix = -a.ux, iy = -a.uy;
        const cross = ix * b.uy - iy * b.ux, dot = ix * b.ux + iy * b.uy;
        const ang = (Math.atan2(cross, dot) * 180) / Math.PI;
        if (Math.abs(ang) > 160) continue; // разворот не рисуем
        const kind: LinkKind = Math.abs(ang) < 35 ? "through" : ang > 0 ? "left" : "right";
        if (allowed && !allowed.includes(kind)) continue;
        // на какую полосу выезда: направо - в крайнюю правую, налево - в крайнюю левую, прямо - в ту же по счету справа
        const fromRight = a.inc.length - 1 - li;
        const target = kind === "right" ? b.out[b.out.length - 1] : kind === "left" ? b.out[0] : b.out[Math.max(0, b.out.length - 1 - fromRight)];
        const setB = Math.min(widest / 2 + 3, b.len * 0.8);
        // точки на краю перекрестка: конец полосы подъезда и начало полосы выезда
        const p0x = a.ux * setA + -a.uy * lane.t, p0y = a.uy * setA + a.ux * lane.t; // вправо по ходу к узлу: (-uy, ux)
        const p1x = b.ux * setB + b.uy * target.t, p1y = b.uy * setB + -b.ux * target.t; // вправо по ходу от узла: (uy, -ux)
        // плавная кривая: опорная точка там, где продолжение полосы подъезда встречает полосу выезда
        const cx = kind === "through" ? (p0x + p1x) / 2 : -a.uy * lane.t + b.uy * target.t;
        const cy = kind === "through" ? (p0y + p1y) / 2 : a.ux * lane.t + -b.ux * target.t;
        const path: [number, number][] = [];
        for (let s = 0; s <= 10; s++) {
          const f = s / 10, g = 1 - f;
          path.push(ll(g * g * p0x + 2 * g * f * cx + f * f * p1x, g * g * p0y + 2 * g * f * cy + f * f * p1y));
        }
        links.push({ path, kind });
      }
    });
  }
  return links;
}
