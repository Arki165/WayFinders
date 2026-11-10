// Полосы дороги. В OSM полоса не отдельная линия: ее свойства пишутся тегами дороги
// через «|», по полосам слева направо по ходу движения (turn:lanes=left|through).
// Так граф не ломается, а SUMO и MatSim понимают полосы.
import { create } from "zustand";
import type { OsmWay, Tags } from "../osm/types";
import { lanesOf } from "./roads";

export type LaneDir = "forward" | "backward"; // по направлению линии дороги или против
export type LaneKind = "general" | "bus" | "bicycle";

export interface Lane {
  dir: LaneDir;
  turn: string; // повороты через «;»: left;through. Пусто - не задано
  changeLeft?: boolean; // можно перестроиться влево по ходу движения (undefined - не задано)
  changeRight?: boolean;
  kind: LaneKind;
  speed: string; // км/ч, пусто - как у дороги
  width: string; // м, пусто - по умолчанию
}

// Полосы храним в порядке поперек дороги: слева направо, если смотреть по направлению линии.
// Правостороннее движение: полосы «обратно» слева, «туда» справа.
export type Lanes = Lane[];

export const LANE_WIDTH = 3.2; // ширина полосы по умолчанию, м
const BIKE_WIDTH = 1.5;

// Повороты: тег OSM, подпись, стрелка (стрелка вверх - прямо по ходу)
export const TURNS: [string, string, string][] = [
  ["reverse", "Разворот", "↶"],
  ["left", "Налево", "←"],
  ["through", "Прямо", "↑"],
  ["right", "Направо", "→"],
];
const TURN_ARROW: Record<string, string> = { reverse: "↶", left: "←", slight_left: "↖", through: "↑", slight_right: "↗", right: "→", sharp_left: "←", sharp_right: "→", merge_to_left: "↖", merge_to_right: "↗" };
export const turnArrows = (turn: string) => turn.split(";").map((t) => TURN_ARROW[t] ?? "").join("");

// Автобусные полосы по отдельности: их сбрасывает переключатель «Автобусная полоса» в панели дороги
export const BUS_LANE_KEYS = ["bus:lanes", "bus:lanes:forward", "bus:lanes:backward", "psv:lanes", "psv:lanes:forward", "psv:lanes:backward"];

// Все ключи, которые пишутся по полосам
const LANE_KEYS = ["turn", "change", "maxspeed", "width", "bus", "psv", "bicycle"];

function onewayDir(w: OsmWay): LaneDir | null {
  const ow = w.tags.oneway;
  if (ow === "-1") return "backward";
  if (ow === "yes" || ow === "1" || w.tags.junction === "roundabout") return "forward";
  return null;
}

const slots = (v: string | undefined, n: number) => {
  const a = (v ?? "").split("|");
  return Array.from({ length: n }, (_, i) => (v === undefined ? "" : a[i] ?? "").trim());
};

function parseChange(v: string): [boolean | undefined, boolean | undefined] {
  if (v === "yes") return [true, true];
  if (v === "no") return [false, false];
  if (v === "not_left") return [false, true];
  if (v === "not_right") return [true, false];
  return [undefined, undefined];
}

function writeChange(l: Lane): string {
  if (l.changeLeft === undefined && l.changeRight === undefined) return "";
  const a = l.changeLeft !== false, b = l.changeRight !== false;
  return a && b ? "yes" : !a && !b ? "no" : !a ? "not_left" : "not_right";
}

// Полосы одного направления в порядке по ходу движения (слева направо)
function readGroup(t: Tags, dir: LaneDir, n: number, suffix: string): Lane[] {
  const get = (k: string) => slots(t[`${k}:lanes${suffix}`], n);
  const turn = get("turn"), change = get("change"), speed = get("maxspeed"), width = get("width");
  const bus = get("bus"), psv = get("psv"), bike = get("bicycle");
  return Array.from({ length: n }, (_, i) => {
    const [cl, cr] = parseChange(change[i]);
    const kind: LaneKind = bike[i] === "designated" ? "bicycle" : bus[i] === "designated" || psv[i] === "designated" ? "bus" : "general";
    return { dir, turn: turn[i], changeLeft: cl, changeRight: cr, kind, speed: speed[i], width: width[i] };
  });
}

// Автобусные полосы, заданные на всю дорогу (busway=lane - у обоих краев, busway:right=lane - у правого края).
// Так их ставит переключатель «Автобусная полоса» в панели дороги. Если bus:lanes нет, читаем их отсюда.
function applyBusway(t: Tags, lanes: Lanes): Lanes {
  if (lanes.some((l) => l.kind === "bus")) return lanes;
  const edge = (i: number) => { if (lanes[i] && lanes[i].kind === "general") lanes[i].kind = "bus"; };
  if (t.busway === "lane") { edge(0); edge(lanes.length - 1); }
  if (t["busway:right"] === "lane") edge(lanes.length - 1);
  if (t["busway:left"] === "lane") edge(0);
  return lanes;
}

export function getLanes(w: OsmWay): Lanes {
  return applyBusway(w.tags, readLanes(w));
}

function readLanes(w: OsmWay): Lanes {
  const t = w.tags;
  const one = onewayDir(w);
  if (one) {
    const g = readGroup(t, one, lanesOf(w), "");
    return one === "forward" ? g : g.reverse();
  }
  // двустороннее: по полосе в каждую сторону минимум
  const total = lanesOf(w);
  let nf = parseInt(t["lanes:forward"] ?? "", 10), nb = parseInt(t["lanes:backward"] ?? "", 10);
  if (!(nf >= 0) && nb >= 0) nf = total - nb;
  if (!(nb >= 0) && nf >= 0) nb = total - nf;
  if (!(nf >= 0) || !(nb >= 0)) { nf = Math.ceil(total / 2); nb = total - nf; }
  nf = Math.max(1, nf); nb = Math.max(1, nb);
  // полосы «обратно» по ходу их движения идут от середины к краю, поперек дороги - наоборот
  return [...readGroup(t, "backward", nb, ":backward").reverse(), ...readGroup(t, "forward", nf, ":forward")];
}

// Записать полосы обратно в теги дороги. Пустые теги не пишем.
export function lanesToTags(w: OsmWay, lanes: Lanes): Tags {
  const t: Tags = { ...w.tags };
  for (const k of LANE_KEYS) for (const s of ["", ":forward", ":backward"]) delete t[`${k}:lanes${s}`];
  delete t["lanes:forward"];
  delete t["lanes:backward"];
  const fw = lanes.filter((l) => l.dir === "forward");
  const bw = lanes.filter((l) => l.dir === "backward").reverse();
  const put = (group: Lane[], suffix: string) => {
    const vals: Record<string, string[]> = {
      turn: group.map((l) => l.turn),
      change: group.map(writeChange),
      maxspeed: group.map((l) => l.speed),
      width: group.map((l) => l.width),
      bus: group.map((l) => (l.kind === "bus" ? "designated" : "")),
      bicycle: group.map((l) => (l.kind === "bicycle" ? "designated" : "")),
    };
    for (const [k, v] of Object.entries(vals)) if (v.some((x) => x !== "")) t[`${k}:lanes${suffix}`] = v.join("|");
  };
  t.lanes = String(lanes.length);
  // теги автобусных полос на всю дорогу держим в согласии с полосами (их показывает панель дороги)
  for (const k of ["busway", "busway:right", "busway:left", "lanes:bus"]) delete t[k];
  const nBus = lanes.filter((l) => l.kind === "bus").length;
  if (nBus) {
    t["lanes:bus"] = String(nBus);
    const first = lanes[0].kind === "bus", last = lanes[lanes.length - 1].kind === "bus";
    if (first && last && lanes.length > 1) t.busway = "lane";
    else if (last) t["busway:right"] = "lane";
    else if (first) t["busway:left"] = "lane";
  }
  if (fw.length && bw.length) {
    if (t.junction !== "roundabout") delete t.oneway;
    t["lanes:forward"] = String(fw.length);
    t["lanes:backward"] = String(bw.length);
    put(fw, ":forward");
    put(bw, ":backward");
  } else if (fw.length) {
    if (t.junction !== "roundabout") t.oneway = "yes";
    put(fw, "");
  } else {
    t.oneway = "-1";
    put(bw, "");
  }
  return t;
}

export const laneWidth = (l: Lane) => parseFloat(l.width) || (l.kind === "bicycle" ? BIKE_WIDTH : LANE_WIDTH);
export const roadWidth = (w: OsmWay) => getLanes(w).reduce((s, l) => s + laneWidth(l), 0);

// Сторона поперек дороги ("L" - левее по линии) -> сторона по ходу движения полосы
const travelSide = (l: Lane, cross: "L" | "R") => (l.dir === "forward" ? cross : cross === "L" ? "R" : "L");

// Можно ли пересечь линию со стороны cross. undefined - в тегах не задано
export function canCross(l: Lane, cross: "L" | "R"): boolean | undefined {
  return travelSide(l, cross) === "L" ? l.changeLeft : l.changeRight;
}

// Поставить разметку на линии между полосой i и соседом со стороны cross (у обоих полос сразу)
export function setCross(lanes: Lanes, i: number, cross: "L" | "R", allow: boolean): Lanes {
  const r = lanes.map((l) => ({ ...l }));
  const set = (l: Lane, c: "L" | "R") => { if (travelSide(l, c) === "L") l.changeLeft = allow; else l.changeRight = allow; };
  set(r[i], cross);
  const j = cross === "L" ? i - 1 : i + 1;
  if (r[j]) set(r[j], cross === "L" ? "R" : "L");
  return r;
}

// Тип линии разметки между полосами a (левее) и b (правее)
export type Mark = "dashed" | "solid" | "double" | "solid-left" | "solid-right";
export function markBetween(a: Lane, b: Lane, total: number): Mark {
  const center = a.dir !== b.dir;
  // если не задано: между попутными полосами прерывистая, в середине - сплошная (двойная при 4+ полосах), на узкой - прерывистая
  const def = center ? total <= 2 : true;
  const ca = canCross(a, "R") ?? def, cb = canCross(b, "L") ?? def;
  if (ca && cb) return "dashed";
  if (!ca && !cb) return center && total >= 4 ? "double" : "solid";
  // прерывистая со стороны той полосы, которой можно перестраиваться
  return ca ? "solid-right" : "solid-left";
}

// Сдвинуть полосу на другое направление и поставить ее на место (обратные слева)
export function setDir(lanes: Lanes, i: number, dir: LaneDir): { lanes: Lanes; index: number } {
  const moved = { ...lanes[i], dir, changeLeft: undefined, changeRight: undefined };
  const rest = lanes.filter((_, k) => k !== i);
  // полоса встает к середине дороги, между встречными направлениями
  const r = [...rest.filter((l) => l.dir === "backward"), moved, ...rest.filter((l) => l.dir === "forward")];
  return { lanes: r, index: r.indexOf(moved) };
}

export function addLane(lanes: Lanes, dir: LaneDir): { lanes: Lanes; index: number } {
  const l: Lane = { dir, turn: "", kind: "general", speed: "", width: "" };
  // добавляем с края дороги: «туда» справа, «обратно» слева
  const r = dir === "forward" ? [...lanes, l] : [l, ...lanes];
  return { lanes: r, index: r.indexOf(l) };
}

// Выбранная полоса: дорога и номер полосы поперек дороги (слева направо)
export const useLane = create<{ sel: { wayId: number; index: number } | null; setSel: (s: { wayId: number; index: number } | null) => void }>((set) => ({
  sel: null,
  setSel: (sel) => set({ sel }),
}));

// ---------- геометрия: смещение линии вбок на заданное число метров ----------
type P3 = [number, number, number];
const M_LAT = 111320;

// off > 0 - вправо по направлению линии
export function offsetPath(path: P3[], off: number): P3[] {
  if (path.length < 2 || off === 0) return path;
  const k = Math.cos((path[0][1] * Math.PI) / 180) * M_LAT;
  const norm = (a: P3, b: P3): [number, number] => {
    const dx = (b[0] - a[0]) * k, dy = (b[1] - a[1]) * M_LAT;
    const len = Math.hypot(dx, dy) || 1;
    return [dy / len, -dx / len];
  };
  return path.map((p, i) => {
    const n1 = i > 0 ? norm(path[i - 1], p) : null, n2 = i < path.length - 1 ? norm(p, path[i + 1]) : null;
    let nx: number, ny: number, s = 1;
    if (n1 && n2) {
      nx = n1[0] + n2[0]; ny = n1[1] + n2[1];
      const len = Math.hypot(nx, ny) || 1;
      nx /= len; ny /= len;
      s = 1 / Math.max(0.4, nx * n1[0] + ny * n1[1]); // на изломе линия не сужается
    } else [nx, ny] = (n1 ?? n2)!;
    return [p[0] + (nx * off * s) / k, p[1] + (ny * off * s) / M_LAT, p[2]];
  });
}

// Длина линии в метрах и точка на расстоянии d от начала с направлением (градусы от востока против часовой)
function segLen(a: P3, b: P3) {
  const k = Math.cos((a[1] * Math.PI) / 180) * M_LAT;
  return Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * M_LAT);
}
export const pathLength = (path: P3[]) => path.reduce((s, p, i) => (i ? s + segLen(path[i - 1], p) : 0), 0);

export function pointAt(path: P3[], d: number): { pos: P3; angle: number } {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], L = segLen(a, b);
    if (d <= L || i === path.length - 1) {
      const f = L ? Math.min(1, Math.max(0, d / L)) : 0;
      const k = Math.cos((a[1] * Math.PI) / 180);
      const angle = (Math.atan2(b[1] - a[1], (b[0] - a[0]) * k) * 180) / Math.PI;
      return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], angle };
    }
    d -= L;
  }
  return { pos: path[0], angle: 0 };
}

// Прерывистая линия: куски по dash метров через gap метров
export function dashes(path: P3[], dash = 3, gap = 6): P3[][] {
  const L = pathLength(path), out: P3[][] = [];
  for (let s = gap / 2; s < L; s += dash + gap) {
    const e = Math.min(L, s + dash);
    out.push([pointAt(path, s).pos, pointAt(path, e).pos]);
  }
  return out;
}

// Укоротить линию: отрезать a метров в начале и b метров в конце.
// Нужно на перекрестке: полосы примыкающей дороги кончаются у края другой дороги, а не заходят на нее.
export function trimPath(path: P3[], a: number, b: number): P3[] {
  if (a <= 0 && b <= 0) return path;
  const L = pathLength(path);
  if (a + b >= L - 1) return []; // короткий кусок целиком внутри перекрестка
  const out: P3[] = [pointAt(path, a).pos];
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    d += segLen(path[i - 1], path[i]);
    if (d > a && d < L - b) out.push(path[i]);
  }
  out.push(pointAt(path, L - b).pos);
  return out;
}
