// Сравнение текущего графа с исходным файлом
import type { OsmData } from "../osm/types";
import { drivableNodeSet, isDrivable, isRoadSignal, wayName } from "./roads";

export interface WayChange {
  id: number;
  name: string;
  kind: "added" | "deleted" | "changed";
  details: string[]; // что изменилось
}

export function diffData(before: OsmData, after: OsmData): { ways: WayChange[]; nodesMoved: number; nodesAdded: number; nodesDeleted: number; nodeTagsChanged: number } {
  const ways: WayChange[] = [];
  for (const w of after.ways.values()) {
    const old = before.ways.get(w.id);
    if (!old) { ways.push({ id: w.id, name: wayName(w), kind: "added", details: [w.tags.highway ? `highway=${w.tags.highway}` : "новая линия"] }); continue; }
    const details: string[] = [];
    const keys = new Set([...Object.keys(old.tags), ...Object.keys(w.tags)]);
    for (const k of keys) {
      if (old.tags[k] === w.tags[k]) continue;
      if (old.tags[k] === undefined) details.push(`+ ${k}=${w.tags[k]}`);
      else if (w.tags[k] === undefined) details.push(`− ${k}`);
      else details.push(`${k}: ${old.tags[k]} → ${w.tags[k]}`);
    }
    if (old.nodeIds.join() !== w.nodeIds.join()) details.push(old.nodeIds.slice().reverse().join() === w.nodeIds.join() ? "развернуто направление" : "изменены узлы");
    if (details.length) ways.push({ id: w.id, name: wayName(w), kind: "changed", details });
  }
  for (const w of before.ways.values()) if (!after.ways.has(w.id)) ways.push({ id: w.id, name: wayName(w), kind: "deleted", details: [] });

  let nodesMoved = 0, nodesAdded = 0, nodesDeleted = 0, nodeTagsChanged = 0;
  for (const n of after.nodes.values()) {
    const o = before.nodes.get(n.id);
    if (!o) { nodesAdded++; continue; }
    if (o.lat !== n.lat || o.lon !== n.lon) nodesMoved++;
    if (JSON.stringify(o.tags) !== JSON.stringify(n.tags)) nodeTagsChanged++;
  }
  for (const id of before.nodes.keys()) if (!after.nodes.has(id)) nodesDeleted++;
  return { ways, nodesMoved, nodesAdded, nodesDeleted, nodeTagsChanged };
}

// Сводные показатели графа для таблицы "до / после"
export function summary(d: OsmData) {
  const onRoad = drivableNodeSet(d);
  const roads = [...d.ways.values()].filter(isDrivable);
  return {
    roads: roads.length,
    withLanes: roads.filter((w) => w.tags.lanes).length,
    withSpeed: roads.filter((w) => w.tags.maxspeed).length,
    withSurface: roads.filter((w) => w.tags.surface).length,
    oneway: roads.filter((w) => w.tags.oneway === "yes" || w.tags.oneway === "-1").length,
    signals: [...d.nodes.values()].filter((n) => isRoadSignal(n, onRoad)).length,
    signalsTimed: [...d.nodes.values()].filter((n) => isRoadSignal(n, onRoad) && n.tags["wayfinders:cycle"]).length,
    restrictions: [...d.relations.values()].filter((r) => r.tags.type === "restriction").length,
  };
}
