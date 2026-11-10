import { XMLParser } from "fast-xml-parser";
import type { OsmData, OsmMember, Tags } from "./types";
import { tr } from "../i18n";

type Raw = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  htmlEntities: true, // числовые ссылки вида &#39; и &#10; (их пишут osmium и osmconvert)
  isArray: (name) => ["node", "way", "relation", "tag", "nd", "member"].includes(name),
});

function readTags(el: Raw): Tags {
  const tags: Tags = {};
  for (const t of (el.tag as Raw[] | undefined) ?? []) tags[String(t.k)] = String(t.v);
  return tags;
}

function readAttrs(el: Raw, skip: string[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of Object.keys(el)) {
    const v = el[key];
    if (skip.includes(key) || typeof v === "object") continue;
    attrs[key] = String(v);
  }
  return attrs;
}

// Читает текст .osm (из файла или из Overpass API) в модель
export function parseOsm(text: string): OsmData {
  let xml: Raw;
  try {
    xml = parser.parse(text);
  } catch (e) {
    throw new Error(tr("файл поврежден или обрезан ({0})", e instanceof Error ? e.message.slice(0, 60) : String(e)));
  }
  const osm = xml.osm as Raw | undefined;
  if (!osm) throw new Error(tr("Это не файл OSM: нет тега <osm>"));

  const data: OsmData = { nodes: new Map(), ways: new Map(), relations: new Map(), bounds: null, header: readAttrs(osm, []) };

  const b = osm.bounds as Raw | undefined;
  if (b) data.bounds = { minlat: Number(b.minlat), minlon: Number(b.minlon), maxlat: Number(b.maxlat), maxlon: Number(b.maxlon) };
  // рамка с пропущенным или нечисловым краем: считаем заново по узлам (ниже)
  if (data.bounds && !Object.values(data.bounds).every(Number.isFinite)) data.bounds = null;

  // удаленное в JOSM (action="delete") не читаем: иначе после сохранения оно вернулось бы в файл
  const gone = (el: Raw) => el.action === "delete";
  for (const n of (osm.node as Raw[] | undefined) ?? []) {
    const id = Number(n.id), lat = Number(n.lat), lon = Number(n.lon);
    // узел без координат в файл писать нельзя (lat="NaN" не примет ни один симулятор), дороги его пропустят
    if (gone(n) || n.lat === undefined || n.lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    data.nodes.set(id, { id, lat, lon, tags: readTags(n), attrs: readAttrs(n, ["id", "lat", "lon"]) });
  }
  for (const w of (osm.way as Raw[] | undefined) ?? []) {
    if (gone(w)) continue;
    const id = Number(w.id);
    const nodeIds = ((w.nd as Raw[] | undefined) ?? []).map((nd) => Number(nd.ref)).filter((ref) => data.nodes.has(ref));
    data.ways.set(id, { id, nodeIds, tags: readTags(w), attrs: readAttrs(w, ["id"]) });
  }
  for (const r of (osm.relation as Raw[] | undefined) ?? []) {
    const id = Number(r.id);
    const members = ((r.member as Raw[] | undefined) ?? []).map((m): OsmMember => ({ type: m.type as OsmMember["type"], ref: Number(m.ref), role: String(m.role ?? "") }));
    data.relations.set(id, { id, members, tags: readTags(r), attrs: readAttrs(r, ["id"]) });
  }

  // Если в файле нет <bounds> (например, из Overpass), считаем по узлам
  if (!data.bounds && data.nodes.size) {
    let minlat = 90, minlon = 180, maxlat = -90, maxlon = -180;
    for (const n of data.nodes.values()) {
      minlat = Math.min(minlat, n.lat); maxlat = Math.max(maxlat, n.lat);
      minlon = Math.min(minlon, n.lon); maxlon = Math.max(maxlon, n.lon);
    }
    data.bounds = { minlat, minlon, maxlat, maxlon };
  }
  return data;
}
