// Экспорт фаз светофоров для SUMO.
// В OSM нет тега для времени фаз, поэтому SUMO ставит светофорам свое время по умолчанию.
// Сервер проверки принимает отдельный файл с программами светофоров (additional.add.xml).
// Чтобы файл точно подошел к сети, берем схему сигналов из сети SUMO, которую построил сервер
// (network.net.xml из scenario.zip прошлого прогона), и меняем в ней только длительности на наши.
// Только чтение данных, граф не меняется.
import type { OsmData } from "../osm/types";
import { SIGNAL_KEYS } from "./roads";

interface Phase { duration: number; state: string }
export interface SumoSignals {
  xml: string; // текст файла additional.add.xml
  done: number; // светофоров с нашим временем
  noTime: number; // светофор есть в сети, но время в редакторе не задано
  missing: number; // светофор сети не найден в графе
}

// Вид фазы по строке сигналов: желтая, зеленая или «всем красный»
const kindOf = (state: string) => (/[yY]/.test(state) ? "yellow" : /[Gg]/.test(state) ? "green" : "red");

// Длительности фаз по нашему времени: green - зеленый главного направления, yellow - желтый,
// red - сколько главное направление стоит на красном
export function retime(phases: Phase[], green: number, yellow: number, red: number): Phase[] {
  const greens = phases.filter((p) => kindOf(p.state) === "green").length;
  const yellows = phases.filter((p) => kindOf(p.state) === "yellow").length;
  // простой светофор (переход): зеленый, желтый, красный
  if (greens <= 1) return phases.map((p) => ({ ...p, duration: kindOf(p.state) === "green" ? green : kindOf(p.state) === "yellow" ? yellow : red }));
  // перекресток: пока у главного направления красный, едут остальные. Их зеленые делят это время поровну
  const allRed = phases.filter((p) => kindOf(p.state) === "red").reduce((s, p) => s + p.duration, 0);
  const rest = Math.max(5, Math.round((red - yellow * (yellows - 1) - allRed) / (greens - 1)));
  let first = true;
  return phases.map((p) => {
    const k = kindOf(p.state);
    if (k === "yellow") return { ...p, duration: yellow };
    if (k === "red") return p;
    const duration = first ? green : rest;
    first = false;
    return { ...p, duration };
  });
}

export function sumoSignals(data: OsmData, netXml: string): SumoSignals {
  const out: string[] = [];
  let done = 0, noTime = 0, missing = 0;
  // программы светофоров в сети: <tlLogic id="..."> с набором <phase duration state>
  for (const m of netXml.matchAll(/<tlLogic\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/tlLogic>/g)) {
    const id = m[1];
    const phases: Phase[] = [...m[2].matchAll(/<phase\s+duration="([\d.]+)"\s+state="([^"]+)"/g)].map((p) => ({ duration: Number(p[1]), state: p[2] }));
    // светофор SUMO называется номером узла OSM
    const node = data.nodes.get(Number(id));
    if (!node || !phases.length) { missing++; continue; }
    const num = (k: string) => { const v = Number(node.tags[k]); return v > 0 ? v : null; };
    const green = num(SIGNAL_KEYS.green), yellow = num(SIGNAL_KEYS.yellow), red = num(SIGNAL_KEYS.red);
    if (green === null || yellow === null || red === null) { noTime++; continue; }
    // программа с новым именем: SUMO загрузит ее поверх стандартной и будет работать по ней
    out.push(`    <tlLogic id="${id}" type="static" programID="wayfinder" offset="0">`);
    for (const p of retime(phases, green, yellow, red)) out.push(`        <phase duration="${p.duration}" state="${p.state}"/>`);
    out.push("    </tlLogic>");
    done++;
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Wayfinder: время фаз светофоров из редактора -->\n<additional>\n${out.join("\n")}\n</additional>\n`;
  return { xml, done, noTime, missing };
}

// Высоты мостов для Webots (поле elevation.xml на сервере проверки).
// Рельеф не учитываем: все дороги на нуле, поднимаем только мосты.
// Высота моста = 5 м на каждый уровень layer, плавный въезд 40 м, под мостом ставятся опоры.
export const BRIDGE_STEP_M = 5;
export const BRIDGE_RAMP_M = 40;

export function bridgeElevation(data: OsmData): { xml: string; count: number } {
  const out: string[] = [];
  for (const w of data.ways.values()) {
    const t = w.tags;
    if (!t.highway && !t.railway) continue; // только дороги и пути
    if (!t.bridge || t.bridge === "no") continue;
    const layer = Number(t.layer) || 1; // мост без layer считаем первым уровнем
    if (layer <= 0) continue;
    const name = t.name ? ` <!-- ${t.name.replace(/--/g, "-")} -->` : "";
    out.push(`<road way="${w.id}" height="${layer * BRIDGE_STEP_M}" ramp="${BRIDGE_RAMP_M}" supports="true"/>${name}`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Wayfinder: высоты мостов, ${BRIDGE_STEP_M} м на уровень, рельеф не учитывается -->\n<elevation>\n${out.join("\n")}\n</elevation>\n`;
  return { xml, count: out.length };
}
