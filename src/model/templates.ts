// Шаблоны дорог: типовой набор тегов одним кликом
import type { Tags } from "../osm/types";

export const TEMPLATES: Record<string, { name: string; tags: Tags }> = {
  primary: { name: "Магистраль 2+2, 60", tags: { highway: "primary", lanes: "4", "lanes:forward": "2", "lanes:backward": "2", maxspeed: "60", oneway: "no", surface: "asphalt" } },
  secondary: { name: "Районная 1+1, 60", tags: { highway: "secondary", lanes: "2", maxspeed: "60", oneway: "no", surface: "asphalt" } },
  oneway: { name: "Односторонняя, 2 полосы", tags: { highway: "secondary", lanes: "2", maxspeed: "60", oneway: "yes", surface: "asphalt" } },
  residential: { name: "Жилая 1+1, 40", tags: { highway: "residential", lanes: "2", maxspeed: "40", oneway: "no", surface: "asphalt" } },
  service: { name: "Проезд, 20", tags: { highway: "service", lanes: "1", maxspeed: "20" } },
  dirt: { name: "Грунтовая, 40", tags: { highway: "unclassified", lanes: "2", maxspeed: "40", surface: "dirt" } },
  link: { name: "Съезд, 1 полоса", tags: { highway: "primary_link", lanes: "1", maxspeed: "40", oneway: "yes" } },
};

// Шаблоны, которые добавляются к существующим тегам (не меняют класс дороги)
export const MODIFIERS: Record<string, { name: string; tags: Tags; remove?: string[] }> = {
  bridge: { name: "Мост", tags: { bridge: "yes", layer: "1" }, remove: ["tunnel"] },
  tunnel: { name: "Тоннель", tags: { tunnel: "yes", layer: "-1" }, remove: ["bridge"] },
  ground: { name: "Обычный уровень", tags: {}, remove: ["bridge", "tunnel", "layer"] },
  roundabout: { name: "Кольцо", tags: { junction: "roundabout", oneway: "yes" } },
};
