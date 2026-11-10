import type { OsmData, Tags } from "./types";

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function attrsToString(attrs: Record<string, string>): string {
  let s = "";
  for (const key of Object.keys(attrs)) {
    if (key === "action") continue;
    s += ` ${key}="${esc(attrs[key])}"`;
  }
  return s;
}

function tagsToXml(tags: Tags): string {
  let s = "";
  for (const k of Object.keys(tags)) s += `    <tag k="${esc(k)}" v="${esc(tags[k])}"/>\n`;
  return s;
}

// Новые элементы в редакторе имеют отрицательные id.
// SUMO и MatSim с ними работают плохо, поэтому при записи даем им положительные id
// больше максимального в файле.
function makeIdMap(ids: Iterable<number>): Map<number, number> {
  const list = [...ids];
  // максимум циклом: Math.max(...list) на крупном городе (сотни тысяч узлов) переполняет стек
  let max = 0;
  for (const id of list) if (id > max) max = id;
  let next = max + 1;
  const map = new Map<number, number>();
  for (const id of list.filter((x) => x < 0).sort((a, b) => b - a)) map.set(id, next++);
  return map;
}

export function writeOsm(data: OsmData): string {
  const nodeIds = makeIdMap(data.nodes.keys());
  const wayIds = makeIdMap(data.ways.keys());
  const relIds = makeIdMap(data.relations.keys());
  const nid = (id: number) => nodeIds.get(id) ?? id;
  const wid = (id: number) => wayIds.get(id) ?? id;
  const rid = (id: number) => relIds.get(id) ?? id;
  const fresh = { version: "1", visible: "true" };

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  parts.push(`<osm version="0.6" generator="WayFinders"${data.header.copyright ? ` copyright="${esc(data.header.copyright)}"` : ""}>\n`);
  if (data.bounds) {
    const b = data.bounds;
    parts.push(`  <bounds minlat="${b.minlat}" minlon="${b.minlon}" maxlat="${b.maxlat}" maxlon="${b.maxlon}"/>\n`);
  }
  for (const n of data.nodes.values()) {
    const attrs = n.id < 0 ? fresh : n.attrs;
    const head = `  <node id="${nid(n.id)}"${attrsToString(attrs)} lat="${n.lat.toFixed(7)}" lon="${n.lon.toFixed(7)}"`;
    parts.push(Object.keys(n.tags).length ? `${head}>\n${tagsToXml(n.tags)}  </node>\n` : `${head}/>\n`);
  }
  for (const w of data.ways.values()) {
    if (w.nodeIds.length < 2) continue;
    const attrs = w.id < 0 ? fresh : w.attrs;
    let s = `  <way id="${wid(w.id)}"${attrsToString(attrs)}>\n`;
    for (const ref of w.nodeIds) s += `    <nd ref="${nid(ref)}"/>\n`;
    parts.push(s + tagsToXml(w.tags) + "  </way>\n");
  }
  for (const r of data.relations.values()) {
    const attrs = r.id < 0 ? fresh : r.attrs;
    let s = `  <relation id="${rid(r.id)}"${attrsToString(attrs)}>\n`;
    for (const m of r.members) {
      const ref = m.type === "node" ? nid(m.ref) : m.type === "way" ? wid(m.ref) : rid(m.ref);
      s += `    <member type="${m.type}" ref="${ref}" role="${esc(m.role)}"/>\n`;
    }
    parts.push(s + tagsToXml(r.tags) + "  </relation>\n");
  }
  parts.push("</osm>\n");
  return parts.join("");
}
