// Модель данных OSM. От нее зависят все части редактора.

export type Tags = Record<string, string>;

export interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  tags: Tags;
  attrs: Record<string, string>; // version, user, timestamp... сохраняем как есть
}

export interface OsmWay {
  id: number;
  nodeIds: number[];
  tags: Tags;
  attrs: Record<string, string>;
}

export interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
}

export interface OsmRelation {
  id: number;
  members: OsmMember[];
  tags: Tags;
  attrs: Record<string, string>;
}

export interface OsmBounds {
  minlat: number;
  minlon: number;
  maxlat: number;
  maxlon: number;
}

export interface OsmData {
  nodes: Map<number, OsmNode>;
  ways: Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
  bounds: OsmBounds | null;
  header: Record<string, string>; // атрибуты тега <osm>
}

// Глубокая копия всей карты (нужна, чтобы хранить исходник для сравнения)
export function cloneData(d: OsmData): OsmData {
  const nodes = new Map<number, OsmNode>();
  for (const n of d.nodes.values()) nodes.set(n.id, { ...n, tags: { ...n.tags }, attrs: { ...n.attrs } });
  const ways = new Map<number, OsmWay>();
  for (const w of d.ways.values()) ways.set(w.id, { ...w, nodeIds: [...w.nodeIds], tags: { ...w.tags }, attrs: { ...w.attrs } });
  const relations = new Map<number, OsmRelation>();
  for (const r of d.relations.values()) relations.set(r.id, { ...r, members: r.members.map((m) => ({ ...m })), tags: { ...r.tags }, attrs: { ...r.attrs } });
  return { nodes, ways, relations, bounds: d.bounds ? { ...d.bounds } : null, header: { ...d.header } };
}
