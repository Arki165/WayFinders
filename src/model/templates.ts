// Шаблоны дорог: типовой набор тегов одним кликом
import type { Tags } from "../osm/types";

// kind: "track" - рельсовые пути, "area" - здание (замкнутый контур); их можно только нарисовать, к дороге они не применяются
export const TEMPLATES: Record<string, { name: string; tags: Tags; kind?: "track" | "area" | "path" }> = {
  primary: { name: "Магистраль 2+2, 60", tags: { highway: "primary", lanes: "4", "lanes:forward": "2", "lanes:backward": "2", maxspeed: "60", oneway: "no", surface: "asphalt" } },
  secondary: { name: "Районная 1+1, 60", tags: { highway: "secondary", lanes: "2", maxspeed: "60", oneway: "no", surface: "asphalt" } },
  oneway: { name: "Односторонняя, 2 полосы", tags: { highway: "secondary", lanes: "2", maxspeed: "60", oneway: "yes", surface: "asphalt" } },
  residential: { name: "Жилая 1+1, 40", tags: { highway: "residential", lanes: "2", maxspeed: "40", oneway: "no", surface: "asphalt" } },
  service: { name: "Проезд, 20", tags: { highway: "service", lanes: "1", maxspeed: "20" } },
  dirt: { name: "Грунтовая, 40", tags: { highway: "unclassified", lanes: "2", maxspeed: "40", surface: "ground" } },
  link: { name: "Съезд, 1 полоса", tags: { highway: "primary_link", lanes: "1", maxspeed: "40", oneway: "yes" } },
  sidewalk: { name: "Тротуар вдоль дороги", tags: { highway: "footway", footway: "sidewalk" }, kind: "path" },
  footway: { name: "Пешеходная дорожка", tags: { highway: "footway" }, kind: "path" },
  tram: { name: "Трамвайные пути", tags: { railway: "tram" }, kind: "track" },
  rail: { name: "Железная дорога", tags: { railway: "rail" }, kind: "track" },
  building: { name: "Здание (кликайте углы)", tags: { building: "yes", "building:levels": "5" }, kind: "area" },
};

// Шаблоны, которые добавляются к существующим тегам (не меняют класс дороги)
export const MODIFIERS: Record<string, { name: string; tags: Tags; remove?: string[] }> = {
  bridge: { name: "Мост", tags: { bridge: "yes", layer: "1" }, remove: ["tunnel"] },
  tunnel: { name: "Тоннель", tags: { tunnel: "yes", layer: "-1" }, remove: ["bridge"] },
  ground: { name: "Без сооружения", tags: {}, remove: ["bridge", "tunnel", "layer"] },
};

// ---------- свои шаблоны ----------
// Шаблон - набор линий. Точки в метрах от места вставки: x на восток, y на север.
export interface CustomLine { tags: Tags; pts: [number, number][]; closed?: boolean }
export interface CustomTemplate { id: string; name: string; lines: CustomLine[] }

const KEY = "wayfinders-templates";

export function loadCustom(): CustomTemplate[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveCustom(list: CustomTemplate[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* хранилище недоступно */ }
}
