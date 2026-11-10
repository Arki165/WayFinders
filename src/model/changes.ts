// Какие дороги изменились по сравнению с исходным файлом.
// Нужно, чтобы показать правки прямо на карте.
import type { OsmData, OsmWay } from "../osm/types";
import { isDrivable } from "./roads";
import { tr } from "../i18n";

export type ChangeKind = "added" | "changed" | "deleted";

export interface ChangedRoad {
  id: number;
  kind: ChangeKind;
  path: [number, number][];
}

function sameTags(a: OsmWay, b: OsmWay): boolean {
  const keysA = Object.keys(a.tags);
  if (keysA.length !== Object.keys(b.tags).length) return false;
  return keysA.every((k) => a.tags[k] === b.tags[k]);
}

function pathOf(data: OsmData, w: OsmWay): [number, number][] {
  const path: [number, number][] = [];
  for (const id of w.nodeIds) {
    const n = data.nodes.get(id);
    if (n) path.push([n.lon, n.lat]);
  }
  return path;
}

export function changedRoads(before: OsmData, after: OsmData): ChangedRoad[] {
  const result: ChangedRoad[] = [];

  for (const w of after.ways.values()) {
    if (!isDrivable(w)) continue;
    const old = before.ways.get(w.id);
    let kind: ChangeKind | null = null;
    if (!old) {
      kind = "added";
    } else if (!sameTags(old, w) || old.nodeIds.join() !== w.nodeIds.join()) {
      kind = "changed";
    } else {
      // теги те же, но мог сдвинуться какой-то узел дороги
      for (const id of w.nodeIds) {
        const n = after.nodes.get(id);
        const o = before.nodes.get(id);
        if (n && o && (n.lat !== o.lat || n.lon !== o.lon)) { kind = "changed"; break; }
      }
    }
    if (kind) result.push({ id: w.id, kind, path: pathOf(after, w) });
  }

  // удаленные дороги рисуем по старым координатам
  for (const w of before.ways.values()) {
    if (isDrivable(w) && !after.ways.has(w.id)) {
      result.push({ id: w.id, kind: "deleted", path: pathOf(before, w) });
    }
  }

  return result.filter((r) => r.path.length >= 2);
}

export const CHANGE_COLORS: Record<ChangeKind, [number, number, number, number]> = {
  added: [40, 170, 90, 170],
  changed: [245, 150, 30, 170],
  deleted: [220, 50, 50, 170],
};

export const CHANGE_TEXT: Record<ChangeKind, string> = {
  get added() { return tr("новая"); },
  get changed() { return tr("изменена"); },
  get deleted() { return tr("удалена"); },
};
