import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// Фоновый поток MapLibre собираем отдельным файлом, иначе в Electron из файла он не грузится
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { IconLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { useEditor, addWay, type DrawPoint, addBuildingCorner, moveBuildingDone, newId, removeBuildingCorner, lineHitsBuilding, THROUGH_BUILDING, deleteNode, deleteWay, insertNode, joinNodes, joinNodeToWay, moveNodeDone, selectSection, setNodeTags, splitWay, toggleWay, unjoinNode } from "../model/store";
import { drivableNodeSet, isDrivable, isRoadSignal, roadClass } from "../model/roads";
import { calcWay, zLevel, Z_COLORS } from "../model/calc";
import { TEMPLATES } from "../model/templates";
import { dashes, getLanes, laneWidth, markBetween, offsetPath, pathLength, pointAt, roadWidth, trimPath, useLane } from "../model/lanes";
import { buildingIndex, tallestUnder } from "../model/buildings";
import { BUS_LETTER_URL, turnIconUrl } from "./turnIcons";
import { cityPois, isMetroWay, metroLineCount, metroLines, poiKind, walkRadius, zebras, type Poi, type PoiKind } from "../model/poi";
const poiKindOf = (n: Parameters<typeof poiKind>[0] | undefined) => (n ? poiKind(n) : null);

const POI_TEXT: Record<PoiKind, string> = { crossing: "Пешеходный переход", bus: "Автобусная остановка", tram: "Трамвайная остановка", train: "Ж/д станция или платформа", metro: "Станция метро", entrance: "Вход в метро" };
import { ICON_MAPPING_2X, loadIconAtlas } from "./mapIcons";
import { getRoute, toggleRouteStop, toggleRouteWay, useRoute } from "../model/routes";
import LayersPanel, { loadLayers, saveLayers, type Level, type LayerShow } from "./LayersPanel";
import { changedRoads, CHANGE_COLORS, CHANGE_TEXT, type ChangeKind, type ChangedRoad } from "../model/changes";
import type { OsmData, OsmWay } from "../osm/types";

export type Basemap = "map" | "satellite";

// Цвета подложки. В темной теме светлую схему переворачиваем по яркости, но не до черного,
// а в мягкий графит (как темные карты 2ГИС); вода остается синей. В светлой подложка слегка приглушена, но не обесцвечена:
// здания на ней отличаются от земли оттенком, без цвета они пропадают.
const bgColor = (dark: boolean) => (dark ? "#1c1e22" : "#e9ebee");
function mapPaint(dark: boolean) {
  return dark
    ? { "raster-opacity": 0.9, "raster-saturation": -0.7, "raster-hue-rotate": 180, "raster-brightness-min": 0.74, "raster-brightness-max": 0.14 }
    : { "raster-opacity": 0.8, "raster-saturation": -0.45, "raster-hue-rotate": 0, "raster-brightness-min": 0.06, "raster-brightness-max": 1 };
}

// карта сразу создается в цветах текущей темы
const makeStyle = (dark: boolean): maplibregl.StyleSpecification => ({
  version: 8,
  sources: {
    map: { type: "raster", tiles: ["esri://World_Street_Map/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Esri, © OpenStreetMap" },
    satellite: { type: "raster", tiles: ["esri://World_Imagery/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Esri World Imagery" },
    // рельеф для глобуса в 3D: высоты (terrarium) отдельно для поверхности и для теней
    dem: { type: "raster-dem", tiles: [DEM_URL], encoding: "terrarium", tileSize: 256, maxzoom: 10, attribution: "Mapzen Terrain" },
    "dem-shade": { type: "raster-dem", tiles: [DEM_URL], encoding: "terrarium", tileSize: 256, maxzoom: 10 },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": bgColor(dark) } },
    { id: "map", type: "raster", source: "map", paint: mapPaint(dark) },
    { id: "satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
    { id: "shade", type: "hillshade", source: "dem-shade", layout: { visibility: "none" }, paint: shadePaint(dark) },
  ],
  sky: skySpec(dark),
});

// ---------- глобус при сильном отдалении ----------
// Дальше этого приближения карта натягивается на шар (как в 2ГИС), ближе - обычная плоская.
// В 3D на шаре еще и небольшой рельеф. На уровне улиц рельефа нет: дороги рисуются по плоской земле.
const GLOBE_ZOOM = 6;
const DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
function shadePaint(dark: boolean) {
  return dark
    ? { "hillshade-shadow-color": "#0c0d10", "hillshade-highlight-color": "#4a4d58", "hillshade-accent-color": "#15161a", "hillshade-exaggeration": 0.45 }
    : { "hillshade-shadow-color": "#6f7480", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#8a8f99", "hillshade-exaggeration": 0.35 };
}
// свечение атмосферы вокруг шара, на плоской карте его нет
function skySpec(dark: boolean): maplibregl.SkySpecification {
  return {
    "sky-color": dark ? "#1b2433" : "#a9c4e4",
    "horizon-color": dark ? "#3b4a63" : "#dbe7f3",
    "fog-color": dark ? "#1c1e22" : "#e9ebee",
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, GLOBE_ZOOM - 1, 0.8, GLOBE_ZOOM, 0],
  };
}
let globe3d = false; // 3D включено: на шаре показываем рельеф
function applyGlobe() {
  const map = currentMap;
  if (!map || !map.getLayer("shade")) return;
  const onGlobe = map.getZoom() < GLOBE_ZOOM;
  const type = onGlobe ? "globe" : "mercator";
  if (map.getProjection()?.type !== type) map.setProjection({ type });
  const relief = onGlobe && globe3d;
  map.setLayoutProperty("shade", "visibility", relief ? "visible" : "none");
  if (relief && !map.getTerrain()) map.setTerrain({ source: "dem", exaggeration: 6 });
  if (!relief && map.getTerrain()) map.setTerrain(null);
}

maplibregl.setWorkerUrl(workerUrl);

// Плитки подложки Esri. Там, где у Esri нет детальной съемки (за городом, у Байкала, в тайге),
// сервер вместо плитки отдает серую заглушку «Map data not yet available».
// Узнаем ее по размеру и сумме байтов и вместо нее показываем увеличенный кусок плитки
// с меньшим приближением: чуть размыто, но без надписи.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const isPlaceholder = (b: ArrayBuffer) => {
  if (b.byteLength !== 2521) return false;
  let sum = 0;
  for (const v of new Uint8Array(b)) sum += v;
  return sum === 224110;
};
maplibregl.addProtocol("esri", async (params, abort) => {
  const [svc, z, y, x] = params.url.replace("esri://", "").split("/");
  const Z = Number(z), Y = Number(y), X = Number(x);
  for (let up = 0; up <= 6 && Z - up >= 0; up++) {
    const res = await fetch(`${ESRI}/${svc}/MapServer/tile/${Z - up}/${Y >> up}/${X >> up}`, { signal: abort.signal });
    const buf = await res.arrayBuffer();
    if (isPlaceholder(buf)) continue;
    if (up === 0) return { data: buf };
    // вырезаем из плитки-родителя нужный кусок и растягиваем до 256×256
    const size = 256 >> up, bmp = await createImageBitmap(new Blob([buf]));
    const cv = new OffscreenCanvas(256, 256);
    cv.getContext("2d")!.drawImage(bmp, (X % (1 << up)) * size, (Y % (1 << up)) * size, size, size, 0, 0, 256, 256);
    return { data: await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer() };
  }
  throw new Error("Нет плитки подложки");
});

// Стрелка направления у односторонних дорог: SVG-картинка, цвет задается слоем (mask)
const ARROW_ICON = {
  url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path d="M6 4.5L19.5 12 6 19.5l3.2-7.5z" fill="#fff"/></svg>'),
  width: 32, height: 32, mask: true,
};

// Перетаскивание узла: с какого приближения можно и через сколько пикселей начинается
const DRAG_MIN_ZOOM = 14;
const DRAG_START_PX = 4;
const MAG_PX = 14; // радиус магнита при рисовании, пиксели

// Видимая область карты [юг, запад, север, восток] для загрузки района из OSM
let currentMap: maplibregl.Map | null = null;
// Кнопка «Весь граф» в столбике кнопок карты (под приближением и компасом): показывает граф целиком
class FitAllControl implements maplibregl.IControl {
  private box: HTMLDivElement | null = null;
  onAdd() {
    const box = document.createElement("div");
    box.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fit-all";
    btn.title = "Показать весь граф";
    btn.setAttribute("aria-label", "Показать весь граф");
    // та же иконка, что fitAll в Icon.tsx
    btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    btn.onclick = () => {
      const b = useEditor.getState().data?.bounds;
      if (b && currentMap) currentMap.fitBounds([[b.minlon, b.minlat], [b.maxlon, b.maxlat]], { padding: 30, duration: 600 });
    };
    box.appendChild(btn);
    this.box = box;
    return box;
  }
  onRemove() { this.box?.remove(); }
}

export function getMapBounds(): [number, number, number, number] | null {
  if (!currentMap) return null;
  const b = currentMap.getBounds();
  return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
}

// Переключение темы перекрашивает уже созданную подложку
let darkMap = false;
let underground = false; // уровень «Метро»: подложка города бледная
function applyDark() {
  const map = currentMap;
  if (!map || !map.getLayer("map")) return;
  map.setPaintProperty("bg", "background-color", bgColor(darkMap));
  const p = mapPaint(darkMap);
  map.setPaintProperty("map", "raster-opacity", p["raster-opacity"] * (underground ? 0.45 : 1));
  map.setPaintProperty("satellite", "raster-opacity", underground ? 0.45 : 1);
  map.setPaintProperty("map", "raster-saturation", p["raster-saturation"]);
  map.setPaintProperty("map", "raster-hue-rotate", p["raster-hue-rotate"]);
  map.setPaintProperty("map", "raster-brightness-min", p["raster-brightness-min"]);
  map.setPaintProperty("map", "raster-brightness-max", p["raster-brightness-max"]);
  if (map.getLayer("shade")) for (const [k, v] of Object.entries(shadePaint(darkMap))) map.setPaintProperty("shade", k as "hillshade-shadow-color", v as string);
  map.setSky(skySpec(darkMap));
  map.triggerRepaint();
}

// В темной теме яркие дневные цвета дорог смешиваем с фоном, чтобы они не резали глаз
type Rgba = [number, number, number, number];
const DARK_TINT = [62, 60, 80];
function soften(c: Rgba, dark: boolean): Rgba {
  if (!dark) return c;
  // смесь с приглушенным лавандово-серым: белые и желтые дороги не слепят, как на темной карте 2ГИС
  return [c[0] * 0.62 + DARK_TINT[0] * 0.38, c[1] * 0.62 + DARK_TINT[1] * 0.38, c[2] * 0.62 + DARK_TINT[2] * 0.38, c[3]];
}

// Линия, сдвинутая вбок на off метров: off > 0 - вправо по ходу линии, off < 0 - влево
function shiftPath(path: [number, number][], off: number): [number, number][] {
  const kx = 111320 * Math.cos((path[0][1] * Math.PI) / 180), ky = 110540;
  return path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky, l = Math.hypot(dx, dy) || 1;
    return [p[0] + ((dy / l) * off) / kx, p[1] + ((-dx / l) * off) / ky];
  });
}

type P3 = [number, number, number];
// Цвет асфальта с оттенком класса дороги: на нем видна белая разметка
const asphalt = (c: number[]): [number, number, number, number] => [c[0] * 0.35 + 105 * 0.65, c[1] * 0.35 + 108 * 0.65, c[2] * 0.35 + 104 * 0.65, c[3]];
type RoadItem = { id: number; path: P3[]; color: [number, number, number, number]; width: number };
type Pt = { id: number; pos: [number, number] };
type LaneItem = { wayId: number; index: number; path: P3[]; kind: string; width: number };

// Высота мостов и какие концы мостов стыкуются с другим мостом (там съезда на землю нет)
interface Bridges { h: Map<number, number>; joint: Set<number> }

// Мосты: высота по уровню (layer × 6 м), а над зданием - выше самой высокой крыши на 4 м
function bridgeInfo(data: OsmData): Bridges {
  const h = new Map<number, number>(), joint = new Set<number>(), cnt = new Map<number, number>();
  const list = [...data.ways.values()].filter((w) => w.tags.bridge === "yes" && isDrivable(w) && w.nodeIds.length >= 2);
  if (!list.length) return { h, joint };
  const ix = buildingIndex(data);
  for (const w of list) {
    const lvl = Math.max(1, parseInt(w.tags.layer ?? "1", 10) || 1);
    const roof = tallestUnder(data, ix, w);
    h.set(w.id, Math.max(lvl * 6, roof ? roof + 4 : 0));
    for (const id of [w.nodeIds[0], w.nodeIds[w.nodeIds.length - 1]]) cnt.set(id, (cnt.get(id) ?? 0) + 1);
  }
  for (const [id, c] of cnt) if (c > 1) joint.add(id);
  return { h, joint };
}

// Линия дороги с высотой. Мост поднимается плавно: съезд длиной до трети моста (не меньше 20 м),
// по кривой без изломов, а не вертикальной ступенькой от крайнего узла («буквой Г»).
const M_DEG = 111320;
function roadPath(data: OsmData, w: OsmWay, br?: Bridges): P3[] {
  const pts = w.nodeIds.map((id) => data.nodes.get(id)!);
  const H = br?.h.get(w.id) ?? 0;
  if (!H) return pts.map((n): P3 => [n.lon, n.lat, 0]);
  const k = Math.cos((pts[0].lat * Math.PI) / 180) * M_DEG;
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot((pts[i].lon - pts[i - 1].lon) * k, (pts[i].lat - pts[i - 1].lat) * M_DEG));
  const L = s[s.length - 1];
  const R = Math.min(L * 0.4, Math.max(20, H * 4));
  const up0 = !br!.joint.has(w.nodeIds[0]), up1 = !br!.joint.has(w.nodeIds[w.nodeIds.length - 1]);
  const z = (x: number) => {
    const t = Math.min(1, Math.min(up0 ? x : Infinity, up1 ? L - x : Infinity) / R);
    return H * t * t * (3 - 2 * t);
  };
  // точки через 3 м, чтобы подъем был гладким
  const out: P3[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil((s[i] - s[i - 1]) / 3));
    for (let j = i === 1 ? 0 : 1; j <= n; j++) {
      const t = j / n;
      out.push([a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t, z(s[i - 1] + (s[i] - s[i - 1]) * t)]);
    }
  }
  return out;
}

// Значки светофоров, переходов и остановок - с той же линейки 100 м, дальше светофоры точками
const ICONS_ZOOM = 14.5;

// Полосы и разметку рисуем с приближения, где линейка масштаба показывает 100 м (на широте Иркутска 14,55-15,55)
const LANES_ZOOM = 14.5;

interface Props {
  basemap: Basemap;
  view3d: boolean;
  heat: boolean;
  showBuildings: boolean;
  showChanges: boolean;
  drawTemplate: string;
  magnet: boolean; // точки новой линии прилипают к ближним узлам и дорогам
  dark: boolean;
  children?: ReactNode; // панель над картой под подсказкой (например, выбор шаблона новой дороги)
}

export default function MapView({ basemap, view3d, heat, showBuildings, showChanges, drawTemplate, magnet, dark, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [zoom, setZoom] = useState(15);
  const [draw, setDraw] = useState<DrawPoint[]>([]);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  // что тащим мышью: узел (id) или здание целиком (bld - его узлы и где они были, origin - точка, где нажали)
  const dragRef = useRef<{ id: number; from: [number, number]; moved: boolean; start: [number, number]; bld?: { wayId: number; from: Map<number, [number, number]>; origin: [number, number] }; corner?: { wayId: number; index: number }; newCorner?: { wayId: number; index: number } } | null>(null);

  const data = useEditor((s) => s.data);
  const original = useEditor((s) => s.original);
  const version = useEditor((s) => s.version);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const check = useEditor((s) => s.check);
  const focus = useEditor((s) => s.focus);
  const norms = useEditor((s) => s.norms);
  const highlight = useEditor((s) => s.highlight);
  // подсвеченные дороги (найденная улица, ошибка): красятся в слое, без пересборки всей карты
  const hlSet = useMemo(() => new Set(highlight), [highlight]);
  const laneSel = useLane((s) => s.sel);
  // атлас значков (светофоры, переходы, остановки, метро) - одна картинка, грузится один раз
  const [iconAtlas, setIconAtlas] = useState<string | null>(null);
  useEffect(() => { loadIconAtlas().then(setIconAtlas, (e) => console.error(e)); }, []);
  // уровень карты и видимые слои (панель «Слои»)
  const [layerCfg, setLayerCfg] = useState(loadLayers);
  const level: Level = layerCfg.level, show: LayerShow = layerCfg.show;
  const setLevel = (l: Level) => { setLayerCfg({ level: l, show }); saveLayers(l, show); };
  const setShow = (s: LayerShow) => { setLayerCfg({ level, show: s }); saveLayers(level, s); };
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null);

  // актуальные значения для обработчиков событий карты
  const live = useRef({ tool, draw, selection, drawTemplate, magnet, dark });
  live.current = { tool, draw, selection, drawTemplate, magnet, dark };
  // куда прилипнет точка под курсором при рисовании (кружок на карте)
  const [snapMark, setSnapMark] = useState<DrawPoint | null>(null);

  // ---------- создание карты ----------
  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({ container: box.current, style: makeStyle(live.current.dark), center: [104.262, 52.262], zoom: 15, maxPitch: 70, doubleClickZoom: false, boxZoom: false, trackResize: false }); // Shift+клик нужен для выделения, рамка приближения его перехватывала
    // Когда тянут край панели, карта подгоняет размер сразу и тут же перерисовывается.
    // Встроенная подгонка ждала следующего кадра: картинка растягивалась и «дрожала как желе».
    const ro = new ResizeObserver(() => { map.resize(); map.redraw(); });
    ro.observe(box.current);
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new FitAllControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    // подпись при наведении на значок остановки, перехода или метро
    const overlay = new MapboxOverlay({
      interleaved: false, layers: [],
      getTooltip: ({ object, layer }) => {
        if (layer?.id !== "pois" || !object) return null;
        const p = object as Poi, text = POI_TEXT[p.kind] + (p.name ? ": " + p.name : "");
        return { text, style: { background: "var(--panel)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "6px", padding: "4px 8px", fontSize: "12px" } };
      },
    });
    map.addControl(overlay);
    mapRef.current = map;
    currentMap = map;
    // для проверок в режиме разработки: window.wfMap.project([lon, lat]) дает точку на экране
    if (import.meta.env.DEV) (window as unknown as { wfMap: maplibregl.Map }).wfMap = map;
    overlayRef.current = overlay;
    map.on("zoomend", () => setZoom(map.getZoom()));
    map.on("load", () => { applyDark(); applyGlobe(); }); // уровень «Метро» мог остаться с прошлого запуска
    map.on("zoom", applyGlobe); // шар или плоская карта по приближению
    map.on("moveend", () => { const b = map.getBounds(); setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]); });

    const pick = (x: number, y: number, layerIds?: string[]) => overlay.pickObject({ x, y, radius: 6, layerIds });

    // Магнит при рисовании: точка у курсора прилипает к ближнему узлу (до MAG_PX пикселей),
    // иначе к линии ближней дороги. Дорога липнет к дорогам, тротуар - к дорогам и дорожкам.
    // Здания и рельсы магнитом не пользуются (рельсы стыкуются сами).
    const snapAt = (x: number, y: number, lat: number, lon: number): DrawPoint => {
      const free: DrawPoint = { id: null, lat, lon };
      const d = useEditor.getState().data;
      const tpl = TEMPLATES[live.current.drawTemplate] ?? TEMPLATES.secondary;
      if (!d || !live.current.magnet || tpl.kind === "area" || tpl.kind === "track") return free;
      const ok = (w: OsmWay) => (tpl.kind === "path" ? !!w.tags.highway && w.tags.area !== "yes" : isDrivable(w));
      // сколько градусов в MAG_PX пикселях: узлы дальше даже не проверяем
      const c = map.unproject([x + MAG_PX, y + MAG_PX]);
      const dLon = Math.abs(c.lng - lon), dLat = Math.abs(c.lat - lat);
      let best: DrawPoint | null = null, bestPx = MAG_PX;
      for (const w of d.ways.values()) {
        if (!ok(w)) continue;
        for (const id of w.nodeIds) {
          const n = d.nodes.get(id);
          if (!n || Math.abs(n.lon - lon) > dLon || Math.abs(n.lat - lat) > dLat) continue;
          const p = map.project([n.lon, n.lat]);
          const px = Math.hypot(p.x - x, p.y - y);
          if (px < bestPx) { bestPx = px; best = { id, lat: n.lat, lon: n.lon }; }
        }
      }
      if (best) return best;
      // узла рядом нет: ищем линию дороги под курсором и ближнюю точку на ней
      const hit = overlay.pickObject({ x, y, radius: 10, layerIds: tpl.kind === "path" ? ["roads", "lanes", "others"] : ["roads", "lanes"] });
      const wid = hit?.layer?.id === "lanes" ? (hit.object as LaneItem).wayId : (hit?.object as RoadItem | undefined)?.id;
      const w = wid !== undefined ? d.ways.get(wid) : undefined;
      if (!w || !ok(w)) return free;
      let on: DrawPoint | null = null, onPx = Infinity; // ближайшая точка на линии дороги
      for (let i = 1; i < w.nodeIds.length; i++) {
        const a = d.nodes.get(w.nodeIds[i - 1]), b = d.nodes.get(w.nodeIds[i]);
        if (!a || !b) continue;
        const pa = map.project([a.lon, a.lat]), pb = map.project([b.lon, b.lat]);
        const vx = pb.x - pa.x, vy = pb.y - pa.y, L2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((x - pa.x) * vx + (y - pa.y) * vy) / L2));
        const px = Math.hypot(pa.x + vx * t - x, pa.y + vy * t - y);
        if (px < onPx) { onPx = px; on = { id: null, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, onWay: w.id }; }
      }
      // курсор над самой дорогой (широкая дорога вблизи): точка встает на ее ось, как бы далеко от оси ни был клик
      return on ?? free;
    };

    map.on("mousedown", (e) => {
      if (live.current.tool !== "select") return;
      const st0 = useEditor.getState();
      const sel = st0.selection;
      const bw = sel?.kind === "way" ? st0.data?.ways.get(sel.id) : undefined;
      // ---- выбранное здание: углы, середины стен и само здание ----
      if (bw && bw.tags.building && map.getZoom() >= DRAG_MIN_ZOOM) {
        const hit = pick(e.point.x, e.point.y, ["bld-corners", "bld-mids", "buildings"]);
        const lid = hit?.layer?.id;
        const o = hit?.object as { id?: number; index?: number; pos: [number, number] } | undefined;
        if (lid === "bld-corners" && o?.id !== undefined) {
          e.preventDefault();
          // Shift+клик по углу убирает его
          if (e.originalEvent.shiftKey) return removeBuildingCorner(bw.id, o.id);
          const n = st0.data!.nodes.get(o.id)!;
          map.dragPan.disable();
          dragRef.current = { id: o.id, from: [n.lat, n.lon], moved: false, start: [e.point.x, e.point.y] };
          return;
        }
        if (lid === "bld-mids" && o?.index !== undefined) {
          // середина стены: появляется новый угол, его сразу можно тащить
          e.preventDefault();
          map.dragPan.disable();
          // угол появится, только когда мышь потянет (просто клик ничего не меняет)
          dragRef.current = { id: -1, from: [o.pos[1], o.pos[0]], moved: false, start: [e.point.x, e.point.y], corner: { wayId: bw.id, index: o.index } };
          return;
        }
        // клик по любому месту стены (не только середине): там появляется новый угол, его можно тянуть дальше
        if (lid !== "bld-corners" && lid !== "bld-mids" && !e.originalEvent.shiftKey) {
          let best = { i: -1, px: 7, lat: 0, lon: 0 }; // ближе 7 пикселей к стене
          for (let i = 1; i < bw.nodeIds.length; i++) {
            const a = st0.data!.nodes.get(bw.nodeIds[i - 1]), b = st0.data!.nodes.get(bw.nodeIds[i]);
            if (!a || !b) continue;
            const pa = map.project([a.lon, a.lat]), pb = map.project([b.lon, b.lat]);
            const vx = pb.x - pa.x, vy = pb.y - pa.y, L2 = vx * vx + vy * vy || 1;
            const t = Math.max(0, Math.min(1, ((e.point.x - pa.x) * vx + (e.point.y - pa.y) * vy) / L2));
            const px = Math.hypot(pa.x + vx * t - e.point.x, pa.y + vy * t - e.point.y);
            // у самого угла новый угол не нужен: там тянется сам угол
            if (px < best.px && t > 0.05 && t < 0.95) best = { i, px, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
          }
          if (best.i > 0) {
            e.preventDefault();
            map.dragPan.disable();
            dragRef.current = { id: -1, from: [best.lat, best.lon], moved: false, start: [e.point.x, e.point.y], corner: { wayId: bw.id, index: best.i } };
            return;
          }
        }
        if (lid === "buildings" && (hit?.object as { id: number }).id === bw.id && !e.originalEvent.shiftKey) {
          // само здание: тащим все его узлы
          e.preventDefault();
          map.dragPan.disable();
          const from = new Map<number, [number, number]>();
          for (const id of bw.nodeIds) { const n = st0.data!.nodes.get(id); if (n) from.set(id, [n.lat, n.lon]); }
          dragRef.current = { id: -1, from: [0, 0], moved: false, start: [e.point.x, e.point.y], bld: { wayId: bw.id, from, origin: [e.lngLat.lng, e.lngLat.lat] } };
          return;
        }
      }
      // с Shift узел не таскаем: Shift+клик выделяет участок между узлами
      if (e.originalEvent.shiftKey) return;
      // при сильном отдалении узлы не таскаем: 1 пиксель там - километры, дрожание мыши уносило узел в другой город
      if (map.getZoom() < DRAG_MIN_ZOOM) return;
      const info = pick(e.point.x, e.point.y, ["nodes", "signals", "signal-icons", "pois"]);
      if (!info?.object) return;
      const id = (info.object as Pt).id;
      const n = useEditor.getState().data?.nodes.get(id);
      if (!n) return;
      e.preventDefault();
      map.dragPan.disable();
      dragRef.current = { id, from: [n.lat, n.lon], moved: false, start: [e.point.x, e.point.y] };
      useEditor.getState().select({ kind: "node", id });
    });
    map.on("mousemove", (e) => {
      const st = useEditor.getState();
      const dr = dragRef.current;
      if (dr && st.data) {
        // узел начинает двигаться, только когда мышь ушла дальше нескольких пикселей: обычный клик его не сдвигает
        if (!dr.moved && Math.hypot(e.point.x - dr.start[0], e.point.y - dr.start[1]) < DRAG_START_PX) return;
        if (dr.corner) {
          // мышь потянула от стены: временный угол без истории, в историю он попадет, когда отпустим мышь
          const b = st.data.ways.get(dr.corner.wayId);
          if (!b) { dragRef.current = null; map.dragPan.enable(); return; }
          const id = newId();
          st.data.nodes.set(id, { id, lat: dr.from[0], lon: dr.from[1], tags: {}, attrs: {} });
          b.nodeIds.splice(dr.corner.index, 0, id);
          dr.newCorner = dr.corner;
          dr.corner = undefined;
          dr.id = id;
        }
        if (dr.bld) {
          // здание сдвигается на столько, на сколько ушла мышь от точки нажатия
          const dLon = e.lngLat.lng - dr.bld.origin[0], dLat = e.lngLat.lat - dr.bld.origin[1];
          for (const [id, [lat, lon]] of dr.bld.from) { const p = st.data.nodes.get(id); if (p) { p.lat = lat + dLat; p.lon = lon + dLon; } }
          dr.moved = true;
          st.bump();
          return;
        }
        const n = st.data.nodes.get(dr.id);
        if (n) { n.lat = e.lngLat.lat; n.lon = e.lngLat.lng; dr.moved = true; st.bump(); }
        return;
      }
      if (live.current.tool === "draw") {
        const sp = snapAt(e.point.x, e.point.y, e.lngLat.lat, e.lngLat.lng);
        setSnapMark(sp.id !== null || sp.onWay !== undefined ? sp : null);
        if (live.current.draw.length) setCursor([sp.lon, sp.lat]);
      }
    });
    map.on("mouseup", () => {
      const dr = dragRef.current;
      if (!dr) return;
      dragRef.current = null;
      map.dragPan.enable();
      if (dr.newCorner) {
        // убираем временный угол и записываем настоящий одним шагом (или ничего, если стену вернули на место)
        const st = useEditor.getState(), d = st.data!, n = d.nodes.get(dr.id);
        const b = d.ways.get(dr.newCorner.wayId);
        if (b && n) {
          b.nodeIds.splice(dr.newCorner.index, 1);
          d.nodes.delete(dr.id);
          addBuildingCorner(dr.newCorner.wayId, dr.newCorner.index, n.lat, n.lon);
        }
        return;
      }
      if (dr.moved && dr.bld) moveBuildingDone(dr.bld.wayId, dr.bld.from);
      else if (dr.moved) moveNodeDone(dr.id, dr.from);
    });

    map.on("click", (e) => {
      const st = useEditor.getState();
      if (!st.data) return;
      const t = live.current.tool;
      // узел под курсором важнее круга ошибки вокруг него: иначе узел разорванного перекрестка не выбрать;
      // в инструментах правки круги ошибок вообще не перехватывают клики
      const onNode = pick(e.point.x, e.point.y, ["nodes", "signals", "signal-icons", "pois"]);
      const info = onNode?.object ? onNode : t === "select" ? pick(e.point.x, e.point.y) : pick(e.point.x, e.point.y, t === "delete" ? ["roads", "lanes", "others", "crossings", "transit", "buildings"] : ["roads", "lanes", "others", "crossings", "transit"]);
      const layer = info?.layer?.id;
      // ручки здания обрабатывает нажатие мыши (mousedown), клик по ним выделение не снимает
      if (layer === "bld-corners" || layer === "bld-mids") return;
      const obj = info?.object as (RoadItem & Pt & LaneItem & { key: string }) | undefined;
      if (layer === "errors" && obj) {
        const er = st.check?.errors.find((x) => x.key === obj.key);
        if (er) { st.setHighlight(er.ways); st.select(er.ways.length ? { kind: "way", id: er.ways[0] } : null); }
        return;
      }
      const nodeId = layer === "nodes" || layer === "signals" || layer === "signal-icons" || layer === "pois" ? obj!.id : null;
      // клик по полосе - это клик по ее дороге, а в выборе еще и выбор самой полосы
      const wayId = layer === "roads" || layer === "others" || layer === "crossings" || layer === "transit" || layer === "buildings" ? obj!.id : layer === "lanes" ? obj!.wayId : null;
      const shift = (e.originalEvent as MouseEvent).shiftKey;
      // правка маршрута: клик по дороге добавляет ее в маршрут или убирает, клик по остановке - то же с остановкой
      const rt = useRoute.getState();
      if (t === "select" && rt.editing && rt.id !== null && st.data.relations.has(rt.id)) {
        if (nodeId !== null) {
          const k = poiKindOf(st.data.nodes.get(nodeId));
          if (k === "bus" || k === "tram") return toggleRouteStop(rt.id, nodeId);
          return st.toast("Это не остановка. Кликните значок остановки или дорогу");
        }
        const w = wayId !== null ? st.data.ways.get(wayId) : undefined;
        if (w && (isDrivable(w) || w.tags.railway === "tram")) return toggleRouteWay(rt.id, w.id);
        if (w) return st.toast("Маршрут идет только по проезжим дорогам и трамвайным путям");
        return;
      }
      if (t === "select" && shift) {
        // Shift+клик: дорога добавляется к выделению, второй узел выделяет участок между узлами
        const s = st.selection;
        if (nodeId !== null && s?.kind === "node" && s.id !== nodeId) return selectSection(s.id, nodeId);
        if (nodeId !== null) return st.select({ kind: "node", id: nodeId });
        if (wayId !== null) return toggleWay(wayId);
        return;
      }
      if (t === "select") {
        st.select(nodeId !== null ? { kind: "node", id: nodeId } : wayId !== null ? { kind: "way", id: wayId } : null);
        useLane.getState().setSel(layer === "lanes" && nodeId === null ? { wayId: obj!.wayId, index: obj!.index } : null);
        if (nodeId === null && wayId === null) st.setHighlight([]);
      } else if (t === "draw") {
        const p = nodeId !== null ? st.data.nodes.get(nodeId)! : null;
        const pt: DrawPoint = p ? { id: p.id, lat: p.lat, lon: p.lon } : snapAt(e.point.x, e.point.y, e.lngLat.lat, e.lngLat.lng);
        // дорогу сквозь здание не рисуем: точка не ставится, программа объясняет почему
        const tpl = TEMPLATES[live.current.drawTemplate] ?? TEMPLATES.secondary;
        const prev = live.current.draw;
        if (lineHitsBuilding(prev.length ? [prev[prev.length - 1], pt] : [pt], tpl.tags)) return st.toast(THROUGH_BUILDING);
        setDraw((d) => [...d, pt]);
      } else if (t === "node") {
        if (nodeId !== null) { st.select({ kind: "node", id: nodeId }); return st.toast("Здесь уже есть узел"); }
        if (wayId === null) return st.toast("Кликните по линии дороги, туда встанет новый узел");
        insertNode(wayId, e.lngLat.lat, e.lngLat.lng);
      } else if (t === "join") {
        // шаг 1: выбрать узел, который присоединяем; шаг 2: кликнуть узел или дорогу, к которой присоединяем
        const s = st.selection;
        const from = s?.kind === "node" ? s.id : null;
        if (from === null) {
          if (nodeId === null) return st.toast("Сначала кликните узел, который нужно присоединить (например, конец дороги)");
          st.select({ kind: "node", id: nodeId });
          return;
        }
        if (nodeId === from) return st.select(null);
        if (nodeId !== null) joinNodes(from, nodeId);
        else if (wayId !== null) joinNodeToWay(from, wayId);
        else st.select(null);
      } else if (t === "unjoin") {
        if (nodeId === null) return st.toast("Кликните по узлу, где сходятся дороги");
        unjoinNode(nodeId);
      } else if (t === "signal") {
        if (nodeId === null) return st.toast("Кликните по узлу дороги (включите масштаб поближе)");
        const n = st.data.nodes.get(nodeId)!;
        const tags = { ...n.tags };
        // пешеходный переход в этом узле не пропадает: со светофором он становится регулируемым, без него - обычным
        if (tags.highway === "traffic_signals") {
          if (tags.crossing) { tags.highway = "crossing"; tags.crossing = "uncontrolled"; } else delete tags.highway;
          setNodeTags(nodeId, tags, "Светофор убран");
        } else {
          if (tags.highway === "crossing" || tags.crossing) tags.crossing = "traffic_signals";
          tags.highway = "traffic_signals";
          setNodeTags(nodeId, tags, "Светофор добавлен");
        }
        st.select({ kind: "node", id: nodeId });
      } else if (t === "split") {
        if (nodeId === null) return st.toast("Кликните по среднему узлу дороги");
        const s = st.selection;
        const way = s?.kind === "way" && st.data.ways.get(s.id)?.nodeIds.includes(nodeId) ? st.data.ways.get(s.id)! :
          [...st.data.ways.values()].find((w) => isDrivable(w) && w.nodeIds.indexOf(nodeId) > 0 && w.nodeIds.indexOf(nodeId) < w.nodeIds.length - 1);
        if (!way) return st.toast("Этот узел - конец дороги, резать нечего");
        splitWay(way.id, nodeId);
      } else if (t === "delete") {
        if (nodeId !== null) deleteNode(nodeId);
        else if (wayId !== null) deleteWay(wayId);
      }
    });
    map.on("dblclick", () => { if (live.current.tool === "draw") finishDraw(); });
    return () => { ro.disconnect(); map.remove(); };
  }, []);

  function finishDraw() {
    const pts = live.current.draw;
    setDraw([]);
    setCursor(null);
    if (pts.length < 2) return useEditor.getState().toast("Нужно минимум две точки");
    const tpl = TEMPLATES[live.current.drawTemplate] ?? TEMPLATES.secondary;
    if (tpl.kind === "area" && pts.length < 3) return useEditor.getState().toast("Для здания нужно минимум три угла");
    if (!addWay(pts, tpl.tags)) return;
    useEditor.getState().toast(tpl.kind === "area" ? "Здание добавлено. Этажность меняется справа" : `Добавлено по шаблону «${tpl.name}»`);
  }

  // Enter заканчивает дорогу, Esc отменяет рисование
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tool !== "draw" || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "Enter") finishDraw();
      if (e.key === "Escape") { setDraw([]); setCursor(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => { if (tool !== "draw") { setDraw([]); setCursor(null); setSnapMark(null); } }, [tool]);

  // ---------- подложка, 3D, перелет ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      map.setLayoutProperty("map", "visibility", basemap === "map" ? "visible" : "none");
      map.setLayoutProperty("satellite", "visibility", basemap === "satellite" ? "visible" : "none");
    };
    if (map.getLayer("map")) apply(); else map.once("load", apply);
  }, [basemap]);
  useEffect(() => { darkMap = dark; underground = level === "metro"; applyDark(); }, [dark, level]);
  useEffect(() => {
    mapRef.current?.easeTo({ pitch: view3d ? 55 : 0, bearing: view3d ? -20 : 0, duration: 600 });
    globe3d = view3d;
    applyGlobe();
  }, [view3d]);
  useEffect(() => {
    if (!focus || !mapRef.current) return;
    // рамка: показать объект целиком (например, всю улицу из поиска), но не ближе масштаба 17.5
    if (focus.bounds) mapRef.current.fitBounds([[focus.bounds[0], focus.bounds[1]], [focus.bounds[2], focus.bounds[3]]], { padding: 70, maxZoom: 17.5, duration: 700 });
    else mapRef.current.flyTo({ center: [focus.lon, focus.lat], zoom: focus.zoom ?? Math.max(mapRef.current.getZoom(), 17), duration: 700 });
  }, [focus]);
  useEffect(() => {
    const b = data?.bounds;
    if (b && mapRef.current) mapRef.current.fitBounds([[b.minlon, b.minlat], [b.maxlon, b.maxlat]], { padding: 30, duration: 0 });
  }, [original]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- данные для слоев ----------
  const layersData = useMemo(() => {
    if (!data) return null;
    const onRoad = drivableNodeSet(data);
    // zebra: переход идет через узел, на котором рисуется «зебра»
    type Line = { id: number; path: [number, number][]; color: [number, number, number, number]; width: number; rail: boolean; zebra?: boolean };
    const zebraNode = (id: number) => { const t = data.nodes.get(id)?.tags; return !!t && onRoad.has(id) && (t.highway === "crossing" || t.footway === "crossing" || !!t.crossing); };
    // переходы рисуются поверх дорог, остальные линии под ними
    // transit - выделенные полосы общественного транспорта, рисуются поверх дорог
    const roads: RoadItem[] = [], others: Line[] = [], crossings: Line[] = [], transit: Line[] = [], buildings: { id: number; poly: [number, number][]; h: number }[] = [];
    const deg = new Map<number, number>();
    const ways = [...data.ways.values()];
    const br = bridgeInfo(data);
    const coord = (id: number): [number, number] => { const n = data.nodes.get(id)!; return [n.lon, n.lat]; };
    for (const w of ways) {
      if (w.nodeIds.length < 2) continue;
      if (isDrivable(w)) {
        for (const id of w.nodeIds) deg.set(id, (deg.get(id) ?? 0) + 1);
        const path = roadPath(data, w, br);
        let color: [number, number, number, number] = [...roadClass(w).color, 255];
        if (heat) { const c = calcWay(data, w, norms); color = c.Z !== null ? [...Z_COLORS[zLevel(c.Z, norms)], 255] : [180, 180, 180, 160]; }
        if (w.tags.tunnel === "yes") color = [color[0], color[1], color[2], 110];
        roads.push({ id: w.id, path, color, width: roadWidth(w) });
        // автобусная полоса: красная полоса у края дороги (справа, слева или с двух сторон)
        const t = w.tags, both = t.busway === "lane" || t["busway:both"] === "lane";
        const sides = [...(both || t["busway:right"] === "lane" ? [1] : []), ...((both && t.oneway !== "yes") || t["busway:left"] === "lane" ? [-1] : [])];
        if (sides.length && !heat) {
          const flat = w.nodeIds.map(coord), off = Math.max(0, roadWidth(w) / 2 - 1.6);
          for (const sd of sides) transit.push({ id: w.id, path: shiftPath(flat, sd * off), color: [214, 48, 49, 235], width: 3, rail: false });
        }
      } else if (w.tags.building && showBuildings) {
        const lv = parseFloat(w.tags["building:levels"] ?? "") || 3;
        buildings.push({ id: w.id, poly: w.nodeIds.map(coord), h: lv * 3 });
      } else if (w.tags.railway === "tram" && w.tags.embedded === "yes") {
        // трамвай по проезжей части виден поверх дороги
        transit.push({ id: w.id, path: w.nodeIds.map(coord), color: [130, 70, 190, 240], width: 1.6, rail: true });
      } else if (isMetroWay(w)) {
        continue; // метро рисуется своим слоем
      } else if (w.tags.highway || w.tags.railway) {
        const rail = !!w.tags.railway;
        // рельсы и переходы толще: их выбирают кликом
        const cross = w.tags.footway === "crossing";
        (cross ? crossings : others).push({ id: w.id, path: w.nodeIds.map(coord), color: rail ? [130, 100, 160, 230] : cross ? [60, 60, 60, 220] : [150, 130, 115, 150], width: rail ? 3 : cross ? 3 : 1, rail, zebra: cross && w.nodeIds.some(zebraNode) });
      }
    }
    roads.sort((a, b) => roadClass(data.ways.get(a.id)!).rank - roadClass(data.ways.get(b.id)!).rank);
    const junctions: Pt[] = [];
    for (const id of deg.keys()) junctions.push({ id, pos: coord(id) });
    const signals: Pt[] = [...data.nodes.values()].filter((n) => isRoadSignal(n, onRoad)).map((n) => ({ id: n.id, pos: [n.lon, n.lat] }));
    // стрелки направления у односторонних дорог
    const arrows: { pos: [number, number]; angle: number }[] = [];
    for (const w of ways) {
      if (!isDrivable(w)) continue;
      const ow = w.tags.oneway;
      if (!(ow === "yes" || ow === "1" || ow === "-1" || w.tags.junction === "roundabout")) continue;
      for (let i = 1; i < w.nodeIds.length; i++) {
        let a = coord(w.nodeIds[i - 1]), b = coord(w.nodeIds[i]);
        if (ow === "-1") [a, b] = [b, a];
        const ang = (Math.atan2(b[1] - a[1], (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180)) * 180) / Math.PI;
        arrows.push({ pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], angle: ang });
      }
    }
    // переходы, остановки, метро
    const pois: Poi[] = cityPois(data);
    const metro = metroLines(data);
    const zebra = zebras(data, pois);
    return { br, roads, others, crossings, transit, buildings, junctions, signals, arrows, pois, metro, zebra, metroCount: metro.length ? metroLineCount(data, metro) : 0 };
  }, [data, version, heat, norms, showBuildings]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- полосы и разметка в видимой части карты ----------
  const lanesOn = zoom >= LANES_ZOOM;
  const laneBox = lanesOn ? bbox : null;
  // Какие дороги проходят через каждый узел: нужно, чтобы обрезать полосы на перекрестке
  const nodeWays = useMemo(() => {
    const m = new Map<number, OsmWay[]>();
    if (!data || !lanesOn) return m;
    for (const w of data.ways.values()) {
      if (!isDrivable(w)) continue;
      for (const id of new Set(w.nodeIds)) { const a = m.get(id); if (a) a.push(w); else m.set(id, [w]); }
    }
    return m;
  }, [data, version, lanesOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const laneData = useMemo(() => {
    if (!data || !layersData || !laneBox) return null;
    // Сколько метров полос убрать у конца дороги в узле id. Если дорога примыкает к другой
    // (кольцо, Т-перекресток) или в узле сходятся три и больше дорог, полосы кончаются у края
    // самой широкой соседней дороги. Продолжение улицы (две дороги встык) не трогаем.
    const cutAt = (w: OsmWay, id: number) => {
      const others = (nodeWays.get(id) ?? []).filter((o) => o.id !== w.id);
      const through = others.some((o) => { const i = o.nodeIds.indexOf(id); return i > 0 && i < o.nodeIds.length - 1; });
      if (!through && others.length < 2) return 0;
      return Math.max(0, ...others.map((o) => roadWidth(o) / 2));
    };
    const dw = (laneBox[2] - laneBox[0]) * 0.2, dh = (laneBox[3] - laneBox[1]) * 0.2;
    const inView = (p: P3) => p[0] > laneBox[0] - dw && p[0] < laneBox[2] + dw && p[1] > laneBox[1] - dh && p[1] < laneBox[3] + dh;
    const color = new Map(layersData.roads.map((r) => [r.id, r.color]));
    // Где на дорогу w выходят другие дороги: отрезки вдоль пути (в метрах) слева и справа
    const mouthGaps = (w: OsmWay, path: P3[]) => {
      const left: [number, number][] = [], right: [number, number][] = [];
      const k = Math.cos((path[0][1] * Math.PI) / 180);
      // расстояние от начала пути до каждой его точки
      const dist = [0];
      for (let i = 1; i < path.length; i++) dist.push(dist[i - 1] + pathLength([path[i - 1], path[i]]));
      for (let i = 1; i < w.nodeIds.length - 1; i++) {
        const id = w.nodeIds[i], n = data.nodes.get(id);
        const others = (nodeWays.get(id) ?? []).filter((o) => o.id !== w.id);
        if (!n || !others.length) continue;
        // ближайшая точка пути к узлу и направление дороги в ней
        let j = 0, best = Infinity;
        path.forEach((p, q) => { const dd = Math.hypot((p[0] - n.lon) * k, p[1] - n.lat); if (dd < best) { best = dd; j = q; } });
        const a = path[Math.max(0, j - 1)], b = path[Math.min(path.length - 1, j + 1)];
        const dx = (b[0] - a[0]) * k, dy = b[1] - a[1];
        for (const o of others) {
          const oi = o.nodeIds.indexOf(id);
          // соседние узлы примыкающей дороги: в какую сторону она уходит
          for (const nb of [o.nodeIds[oi - 1], o.nodeIds[oi + 1]]) {
            const m = nb !== undefined ? data.nodes.get(nb) : undefined;
            if (!m) continue;
            const cross = dx * (m.lat - n.lat) - dy * (m.lon - n.lon) * k;
            const half = roadWidth(o) / 2 + 1;
            (cross > 0 ? left : right).push([dist[j] - half, dist[j] + half]);
          }
        }
      }
      return { left, right };
    };
    // Вырезать из линии отрезки gaps (метры от начала)
    const cutOut = (line: P3[], gaps: [number, number][]): P3[][] => {
      if (!gaps.length) return [line];
      const L = pathLength(line), out: P3[][] = [];
      let from = 0;
      for (const [g0, g1] of [...gaps].sort((x, y) => x[0] - y[0])) {
        if (g0 > from + 0.5) out.push(trimPath(line, from, L - Math.min(g0, L)));
        from = Math.max(from, g1);
      }
      if (from < L - 0.5) out.push(trimPath(line, from, 0));
      return out.filter((x) => x.length > 1);
    };
    const items: LaneItem[] = [], lines: { path: P3[] }[] = [], labels: { pos: P3; angle: number; text: string }[] = [];
    const solid = (path: P3[]) => { lines.push({ path }); };
    const dashed = (path: P3[]) => { for (const d of dashes(path)) lines.push({ path: d }); };
    for (const w of data.ways.values()) {
      if (!isDrivable(w) || w.nodeIds.length < 2 || !color.has(w.id)) continue;
      const full = roadPath(data, w, layersData.br);
      if (!full.some(inView)) continue;
      const path = trimPath(full, cutAt(w, w.nodeIds[0]), cutAt(w, w.nodeIds[w.nodeIds.length - 1]));
      if (path.length < 2) continue;
      const lanes = getLanes(w), n = lanes.length;
      const widths = lanes.map(laneWidth);
      // границы полос поперек дороги, от левого края (отрицательные) к правому
      const edges = [-widths.reduce((s, x) => s + x, 0) / 2];
      for (const x of widths) edges.push(edges[edges.length - 1] + x);
      lanes.forEach((l, i) => {
        const lp = offsetPath(path, (edges[i] + edges[i + 1]) / 2);
        items.push({ wayId: w.id, index: i, path: lp, kind: l.kind, width: widths[i] });
        // стрелки поворота у конца полосы по ходу движения, «А» на автобусной полосе
        const tp = l.dir === "forward" ? lp : [...lp].reverse();
        const L = pathLength(tp);
        if (l.turn) { const p = pointAt(tp, L > 30 ? L - 12 : L / 2); labels.push({ pos: p.pos, angle: p.angle - 90, text: l.turn }); }
        if (l.kind === "bus" && L > 30) { const p = pointAt(tp, L / 2); labels.push({ pos: p.pos, angle: p.angle - 90, text: "bus" }); }
      });
      // края проезжей части - сплошные, но с разрывом там, где примыкает другая дорога (въезд не перечеркнут)
      const gaps = mouthGaps(w, path);
      for (const part of cutOut(offsetPath(path, edges[0] + 0.2), gaps.left)) solid(part);
      for (const part of cutOut(offsetPath(path, edges[n] - 0.2), gaps.right)) solid(part);
      for (let i = 1; i < n; i++) {
        const b = edges[i], m = markBetween(lanes[i - 1], lanes[i], n);
        if (m === "dashed") dashed(offsetPath(path, b));
        else if (m === "solid") solid(offsetPath(path, b));
        else if (m === "double") { solid(offsetPath(path, b - 0.15)); solid(offsetPath(path, b + 0.15)); }
        else if (m === "solid-left") { solid(offsetPath(path, b - 0.12)); dashed(offsetPath(path, b + 0.12)); }
        else { dashed(offsetPath(path, b - 0.12)); solid(offsetPath(path, b + 0.12)); }
      }
    }
    return { items, lines, labels, color };
  }, [data, layersData, version, laneBox, nodeWays]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- выбранный маршрут транспорта: линия по его дорогам и остановки по порядку ----------
  const routeId = useRoute((s) => s.id);
  const routeData = useMemo(() => {
    const r = data && routeId !== null ? getRoute(data, routeId) : null;
    if (!r || !data) return null;
    const paths = r.ways.map((id) => data.ways.get(id)!.nodeIds.map((n) => data.nodes.get(n)).filter(Boolean).map((n) => [n!.lon, n!.lat] as [number, number]));
    const stops = r.stops.map((id, i) => { const n = data.nodes.get(id)!; return { pos: [n.lon, n.lat] as [number, number], num: String(i + 1) }; });
    return { color: r.color, paths, stops };
  }, [data, version, routeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- правки относительно исходного файла ----------
  const changes = useMemo(() => {
    if (!data || !original || !showChanges) return [];
    return changedRoads(original, data);
  }, [data, original, version, showChanges]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- списки объектов для слоев по фильтрам «Слоев» ----------
  // Держим их неизменными, пока не поменялись данные или фильтры: тогда deck.gl не загружает
  // в видеокарту тысячи линий заново при каждом выборе дороги или сдвиге карты.
  const cityLvl = level !== "metro";
  const lanesShown = !!(show.roads && show.lanes && cityLvl && laneData);
  const iconsOnZ = zoom >= ICONS_ZOOM, z125 = zoom >= 12.5, z14 = zoom >= 14, z15 = zoom >= 15, z156 = zoom >= 15.6;
  const lists = useMemo(() => {
    if (!layersData) return null;
    const metroLvl = !cityLvl;
    return {
      others: cityLvl ? layersData.others.filter((o) => (o.rail ? show.rail : show.paths)) : [],
      transit: cityLvl ? layersData.transit.filter((t) => (t.rail ? show.rail : show.roads && !(lanesShown && show.lanes))) : [],
      pois: layersData.pois.filter((p) => {
        if (p.kind === "metro") return show.metro && (metroLvl || z125);
        if (p.kind === "entrance") return show.metro && (metroLvl ? z14 : z156);
        if (!cityLvl || !iconsOnZ) return false;
        return p.kind === "crossing" ? show.crossings : show.stops;
      }),
      stationNames: show.metro && (metroLvl || z15) ? layersData.pois.filter((p) => p.kind === "metro" && p.name) : [],
    };
  }, [layersData, show, cityLvl, lanesShown, iconsOnZ, z125, z14, z15, z156]);

  // ---------- слои deck.gl ----------
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!data || !layersData || !lists) { overlay.setProps({ layers: [] }); return; }
    const selWay = selection?.kind === "way" ? data.ways.get(selection.id) : undefined;
    const selIds = new Set(selection?.kind === "ways" ? selection.ids : []);
    const section = selection?.kind === "ways" && selection.section ? selection.section : null;
    const sectionPath = section ? section.nodes.map((id) => data.nodes.get(id)).filter(Boolean).map((n) => [n!.lon, n!.lat] as [number, number]) : [];
    const selNode = selection?.kind === "node" ? selection.id : null;
    const HL: Rgba = [150, 90, 220, 255];
    const showNodes = zoom >= 16.5 || tool !== "select";
    const vertIds = selWay ? selWay.nodeIds : section ? [section.from, section.to] : [];
    const vertices: Pt[] = vertIds.filter((id) => data.nodes.has(id)).map((id) => { const n = data.nodes.get(id)!; return { id, pos: [n.lon, n.lat] as [number, number] }; });
    const nodes = showNodes && zoom >= 15.5 ? [...layersData.junctions, ...vertices] : vertices;
    const drawPath = draw.map((p) => [p.lon, p.lat] as [number, number]);
    if (cursor && drawPath.length) drawPath.push(cursor);

    // ---------- уровень и фильтры слоев ----------
    // «Метро»: линии и станции ярко, город бледным фоном без значков. «Город»: метро тонко, все остальное как обычно.
    const metroLvl = level === "metro", city = !metroLvl;
    const iconsOn = zoom >= ICONS_ZOOM;
    const roadsData = show.roads ? layersData.roads : [];
    const othersData = lists.others;
    const lanesData = show.roads && show.lanes && city ? laneData : null;
    const crossLines = city && show.crossings ? layersData.crossings : [];
    const transitData = lists.transit;
    const zebraData = city && show.crossings && zoom >= 15.6 ? layersData.zebra : [];
    const signalsData = city && show.signals ? layersData.signals : [];
    const poiData = lists.pois;
    const metroData = show.metro ? layersData.metro : [];
    const stationNames = lists.stationNames;
    // на глобусе и отдалении круги ошибок сливаются в пятно: показываем их ближе
    const errs = city && show.errors && zoom >= 9 ? check?.errors ?? [] : [];
    const selPt = selNode !== null && data.nodes.has(selNode) ? [{ pos: [data.nodes.get(selNode)!.lon, data.nodes.get(selNode)!.lat] as [number, number] }] : [];
    const ghost: Rgba = dark ? [120, 130, 142, 80] : [110, 110, 105, 70]; // дороги на уровне «Метро»

    // Плоские слои лежат на одной высоте: если сравнивать их глубину, в наклонном 3D они мерцают полосами.
    // Поэтому они рисуются просто по порядку, а глубину учитывают только объемные здания.
    const flat = { depthCompare: "always" as const, depthWriteEnabled: false };
    // вблизи (линейка 50 м и мельче) полосы как асфальт с яркой разметкой, дальше - цвет класса и бледная разметка
    const laneClose = zoom >= 15.6;
    // вблизи под полосами дорога того же цвета асфальта: на перекрестке и кольце нет светлых пятен
    const asphaltRoads = !!lanesData && laneClose && !heat;
    const buildingsLayer = new PolygonLayer({ id: "buildings", data: city ? layersData.buildings : [], getPolygon: (d) => d.poly, extruded: view3d, getElevation: (d) => d.h, getFillColor: (d) => (d.id === selWay?.id ? [31, 111, 209, 200] : dark ? [56, 58, 66, view3d ? 235 : 190] : [200, 196, 186, view3d ? 230 : 140]), getLineColor: dark ? [84, 87, 98, 220] : [170, 165, 155, 200], lineWidthMinPixels: 0.5, stroked: !view3d, pickable: true, updateTriggers: { getFillColor: [selWay?.id, dark, view3d] } });
    const groundLayers = [
        // метро на уровне «Город»: тонкие линии под дорогами (оно под землей)
        new PathLayer({ id: "metro-under", data: city ? metroData : [], getPath: (d) => d.path, getColor: (d) => [...d.color, 130] as Rgba, getWidth: 3, widthUnits: "pixels", capRounded: true, jointRounded: true }),
        new PathLayer({ id: "others", data: othersData, getPath: (d) => d.path, getColor: (d) => (d.id === selWay?.id ? [31, 111, 209, 255] : soften(hlSet.has(d.id) ? HL : d.color, dark)), getWidth: (d) => (d.id === selWay?.id ? d.width + 2 : d.width), widthUnits: "pixels", widthMinPixels: 1, pickable: true, updateTriggers: { getColor: [dark, selWay?.id, highlight], getWidth: selWay?.id } }),
        // широкая цветная подложка под измененными дорогами
        new PathLayer<ChangedRoad>({ id: "changes", data: changes, getPath: (d) => d.path, getColor: (d) => CHANGE_COLORS[d.kind], getWidth: 14, widthUnits: "pixels", capRounded: true, jointRounded: true }),
        new PathLayer<RoadItem>({ id: "roads-casing", data: city ? roadsData : [], getPath: (d) => d.path, getColor: dark ? [14, 15, 18, 230] : [90, 90, 85, 200], getWidth: (d) => d.width + 1.6, widthUnits: "meters", widthMinPixels: 3, capRounded: true, jointRounded: true }),
        new PathLayer<RoadItem>({
          id: "roads", data: roadsData, getPath: (d) => d.path,
          getColor: (d) => (d.id === selWay?.id || (selIds.has(d.id) && !section) ? [31, 111, 209, 255] : metroLvl ? ghost : soften(asphaltRoads ? asphalt(hlSet.has(d.id) ? HL : d.color) : hlSet.has(d.id) ? HL : d.color, dark)), getWidth: (d) => d.width, widthUnits: "meters", widthMinPixels: 2,
          capRounded: true, jointRounded: true, pickable: true, autoHighlight: true, highlightColor: [31, 111, 209, 120],
          updateTriggers: { getColor: [selWay?.id, version, dark, selection, metroLvl, highlight, asphaltRoads] },
        }),
        // полосы поверх дороги: по ним можно кликнуть, выбранная подсвечена
        new PathLayer<LaneItem>({
          id: "lanes", data: lanesData?.items ?? [], getPath: (d) => d.path, widthUnits: "meters", getWidth: (d) => d.width, widthMinPixels: 1,
          getColor: (d): Rgba => {
            if (d.wayId === selWay?.id) return laneSel?.wayId === d.wayId && laneSel.index === d.index ? [31, 111, 209, 255] : [120, 165, 225, 255];
            if (selIds.has(d.wayId) && !section) return [120, 165, 225, 255];
            if (d.kind === "bus") return soften([196, 92, 80, 255], dark);
            if (d.kind === "bicycle") return soften([92, 165, 108, 255], dark);
            // асфальт с оттенком класса дороги: на нем видна белая разметка
            const c = hlSet.has(d.wayId) ? HL : laneData?.color.get(d.wayId) ?? [200, 200, 200, 255];
            // в режиме загрузки Z и на отдалении цвет класса дороги важнее асфальта
            if (heat || !laneClose) return soften(c, dark);
            return soften(asphalt(c), dark);
          },
          pickable: true, autoHighlight: true, highlightColor: [31, 111, 209, 90],
          updateTriggers: { getColor: [selWay?.id, laneSel?.wayId, laneSel?.index, version, dark, heat, selection, laneClose, highlight] },
        }),
        // полосы общественного транспорта: ширина в метрах, но не тоньше 3 пикселей, чтобы было видно издалека.
        // Автобусную полосу у края не рисуем там, где видны полосы по отдельности: там она сама полоса
        new PathLayer({ id: "transit", data: transitData, getPath: (d) => d.path, getColor: (d) => (d.id === selWay?.id ? [31, 111, 209, 255] : soften(d.rail && hlSet.has(d.id) ? HL : d.color, dark)), getWidth: (d) => d.width, widthUnits: "meters", widthMinPixels: 3, capRounded: true, jointRounded: true, pickable: true, updateTriggers: { getColor: [dark, selWay?.id, highlight] } }),
        // разметка: сплошные линии и штрихи прерывистых
        new PathLayer<{ path: P3[] }>({ id: "lane-lines", data: lanesData?.lines ?? [], getPath: (d) => d.path, getColor: dark ? [205, 210, 215, laneClose ? 210 : 120] : [255, 255, 255, laneClose ? 240 : 150], getWidth: 0.15, widthUnits: "meters", widthMinPixels: laneClose ? 1 : 0.6, updateTriggers: { getColor: [dark, laneClose] } }),
        new IconLayer<{ pos: P3; angle: number; text: string }>({ id: "lane-labels", data: lanesData?.labels ?? [], getPosition: (d) => d.pos, getIcon: (d) => ({ id: "lane:" + d.text, url: d.text === "bus" ? BUS_LETTER_URL : turnIconUrl(d.text), width: 64, height: 64, mask: true }), getAngle: (d) => d.angle, getSize: 2.6, sizeUnits: "meters", sizeMinPixels: 7, getColor: dark ? [225, 230, 236, 235] : [255, 255, 255, 250], billboard: false, updateTriggers: { getColor: dark } }),
        // «зебра» поперек проезжей части у пешеходных переходов (вблизи)
        // линия перехода под «зеброй»: когда зебра видна, линия почти прозрачная (по ней все равно можно кликнуть)
        new PathLayer({ id: "crossings", data: crossLines, getPath: (d) => d.path, getColor: (d): Rgba => (d.id === selWay?.id ? [31, 111, 209, 255] : hlSet.has(d.id) ? soften(HL, dark) : d.zebra && zebraData.length ? [d.color[0], d.color[1], d.color[2], 3] : soften(d.color, dark)), getWidth: 3, widthUnits: "pixels", pickable: true, updateTriggers: { getColor: [dark, selWay?.id, highlight, zebraData.length > 0] } }),
        new PathLayer({ id: "zebra", data: zebraData, getPath: (d) => d, getColor: dark ? [225, 230, 236, 230] : [255, 255, 255, 245], getWidth: 0.5, widthUnits: "meters", widthMinPixels: 1, updateTriggers: { getColor: dark } }),
        // правки поверх дорог: цветная линия по оси, видна на любом приближении
        new PathLayer<ChangedRoad>({ id: "changes-top", data: changes, getPath: (d) => d.path, getColor: (d) => CHANGE_COLORS[d.kind], getWidth: 4, widthUnits: "pixels", capRounded: true, jointRounded: true }),
        // метро на уровне «Метро»: яркие линии с белой обводкой поверх бледного города
        new PathLayer({ id: "metro-casing", data: metroLvl ? metroData : [], getPath: (d) => d.path, getColor: dark ? [22, 23, 27, 255] : [255, 255, 255, 255], getWidth: 10, widthUnits: "pixels", capRounded: true, jointRounded: true, updateTriggers: { getColor: dark } }),
        new PathLayer({ id: "metro", data: metroLvl ? metroData : [], getPath: (d) => d.path, getColor: (d) => [...d.color, 255] as Rgba, getWidth: 6, widthUnits: "pixels", capRounded: true, jointRounded: true }),
        new IconLayer({ id: "arrows", data: zoom >= 16 && city && show.roads ? layersData.arrows : [], getPosition: (d) => d.pos, getIcon: () => ARROW_ICON, getAngle: (d) => d.angle, getSize: 12, sizeUnits: "pixels", getColor: dark ? [225, 230, 236, 230] : [40, 44, 50, 220], billboard: false }),
    ].map((l) => l.clone({ parameters: flat }));
    // круг пешей доступности у выбранной остановки: 350 м автобус и троллейбус, 500 м трамвай
    const stopNode = selNode !== null ? data?.nodes.get(selNode) : undefined;
    const walkR = stopNode ? walkRadius(stopNode) : null;
    // ручки выбранного здания: углы (тащить, Shift+клик - убрать) и середины стен (тащить - новый угол)
    const bldSel = tool === "select" && selWay?.tags.building && zoom >= 14 ? selWay : undefined;
    const corners: { id: number; pos: [number, number] }[] = [], mids: { index: number; pos: [number, number] }[] = [];
    if (bldSel && data) {
      bldSel.nodeIds.forEach((id, i) => {
        const n = data.nodes.get(id);
        if (!n) return;
        if (i < bldSel.nodeIds.length - 1) corners.push({ id, pos: [n.lon, n.lat] });
        const m = i > 0 ? data.nodes.get(bldSel.nodeIds[i - 1]) : undefined;
        if (m) mids.push({ index: i, pos: [(m.lon + n.lon) / 2, (m.lat + n.lat) / 2] });
      });
    }
    // маршрут поверх дорог: темная или светлая обводка, цветная линия, остановки с номерами
    const routeLayers = routeData ? [
      new PathLayer({ id: "route-casing", data: routeData.paths, getPath: (d) => d, getColor: dark ? [20, 21, 25, 230] : [255, 255, 255, 240], getWidth: 10, widthUnits: "pixels", capRounded: true, jointRounded: true, parameters: flat }),
      new PathLayer({ id: "route", data: routeData.paths, getPath: (d) => d, getColor: [...routeData.color, 235] as Rgba, getWidth: 6, widthUnits: "pixels", capRounded: true, jointRounded: true, parameters: flat }),
      new ScatterplotLayer({ id: "route-stops", data: routeData.stops, getPosition: (d) => d.pos, getRadius: 9, radiusUnits: "pixels", getFillColor: dark ? [30, 31, 36, 255] : [255, 255, 255, 255], stroked: true, getLineColor: [...routeData.color, 255] as Rgba, getLineWidth: 2.5, lineWidthUnits: "pixels", parameters: flat }),
      new TextLayer({ id: "route-nums", data: routeData.stops, getPosition: (d) => d.pos, getText: (d) => d.num, getSize: 11, getColor: dark ? [235, 236, 240, 255] : [30, 32, 36, 255], fontWeight: 700, getTextAnchor: "middle", getAlignmentBaseline: "center", parameters: flat }),
    ] : [];
    const handleLayers = [
      ...routeLayers,
        new ScatterplotLayer({ id: "bld-mids", data: mids, getPosition: (d) => d.pos, getRadius: 4, radiusUnits: "pixels", getFillColor: [31, 111, 209, 150], stroked: true, getLineColor: [255, 255, 255, 200], getLineWidth: 1, lineWidthUnits: "pixels", pickable: true, parameters: flat }),
        new ScatterplotLayer({ id: "bld-corners", data: corners, getPosition: (d) => d.pos, getRadius: 6, radiusUnits: "pixels", getFillColor: [255, 255, 255, 255], stroked: true, getLineColor: [31, 111, 209, 255], getLineWidth: 2.5, lineWidthUnits: "pixels", pickable: true, parameters: flat }),
    ];
    const pointLayers = [
        new ScatterplotLayer({ id: "walk-zone", data: stopNode && walkR ? [{ pos: [stopNode.lon, stopNode.lat], r: walkR }] : [], getPosition: (d) => d.pos as [number, number], getRadius: (d) => d.r, radiusUnits: "meters", filled: true, stroked: true, getFillColor: [31, 111, 209, dark ? 40 : 34], getLineColor: [31, 111, 209, 200], getLineWidth: 2, lineWidthUnits: "pixels", parameters: flat }),
        new ScatterplotLayer<Pt>({ id: "nodes", data: nodes, getPosition: (d) => d.pos, getRadius: (d) => (d.id === selNode ? 6 : 3.5), radiusUnits: "pixels", getFillColor: (d) => (d.id === selNode ? [31, 111, 209, 255] : [255, 255, 255, 255]), getLineColor: [31, 111, 209, 255], stroked: true, lineWidthMinPixels: 1.5, pickable: true, updateTriggers: { getRadius: selNode, getFillColor: selNode } }),
        // светофоры: с линейки 100 м значком, дальше красной точкой
        iconsOn
          ? new IconLayer<Pt>({ id: "signal-icons", data: iconAtlas ? signalsData : [], getPosition: (d) => d.pos, iconAtlas: iconAtlas!, iconMapping: ICON_MAPPING_2X, getIcon: () => "signal", getSize: zoom >= 16.5 ? 30 : 24, sizeUnits: "pixels", pickable: true, updateTriggers: { getSize: zoom >= 16.5 } })
          : new ScatterplotLayer<Pt>({ id: "signals", data: signalsData, getPosition: (d) => d.pos, getRadius: 6, radiusUnits: "pixels", getFillColor: [229, 72, 63, 255], getLineColor: [255, 255, 255, 255], stroked: true, lineWidthMinPixels: 2, pickable: true }),
        // переходы, остановки, станции и входы в метро
        new IconLayer<Poi>({ id: "pois", data: iconAtlas ? poiData : [], getPosition: (d) => d.pos, iconAtlas: iconAtlas!, iconMapping: ICON_MAPPING_2X, getIcon: (d) => d.kind, getSize: (d) => (d.kind === "entrance" ? 16 : d.kind === "metro" ? 26 : zoom >= 16.5 ? 26 : 20), sizeUnits: "pixels", pickable: true, updateTriggers: { getSize: zoom >= 16.5 } }),
        new TextLayer<Poi>({ id: "metro-names", data: stationNames, getPosition: (d) => d.pos, getText: (d) => d.name, getSize: 13, getPixelOffset: [0, 20], getColor: dark ? [235, 238, 242, 255] : [30, 30, 30, 255], outlineWidth: 3, outlineColor: dark ? [22, 23, 27, 255] : [255, 255, 255, 255], fontSettings: { sdf: true }, characterSet: "auto", fontWeight: 700, updateTriggers: { getColor: dark } }),
        // кольцо вокруг выбранного узла: видно и под значком
        new ScatterplotLayer({ id: "sel-ring", data: selPt, getPosition: (d) => d.pos, getRadius: 15, radiusUnits: "pixels", filled: false, stroked: true, getLineColor: [31, 111, 209, 255], lineWidthMinPixels: 3 }),
        new ScatterplotLayer({ id: "errors", data: errs, getPosition: (d) => [d.lon, d.lat], getRadius: (d) => (d.type === "trap" || d.type === "isolated" ? 16 : 11), radiusUnits: "pixels", filled: true, getFillColor: (d) => (d.sev === "danger" ? [216, 64, 47, 40] : d.sev === "warn" ? [229, 154, 40, 40] : [61, 107, 143, 40]), getLineColor: (d) => (d.sev === "danger" ? [216, 64, 47, 255] : d.sev === "warn" ? [229, 154, 40, 255] : [61, 107, 143, 255]), stroked: true, lineWidthMinPixels: 2, pickable: true }),
        // участок между двумя узлами (Shift+клик по второму узлу)
        new PathLayer({ id: "section", data: sectionPath.length > 1 ? [{ path: sectionPath }] : [], getPath: (d) => d.path, getColor: [31, 111, 209, 230], getWidth: 7, widthUnits: "pixels", capRounded: true, jointRounded: true }),
        new PathLayer({ id: "draw", data: drawPath.length > 1 ? [{ path: drawPath }] : [], getPath: (d) => d.path, getColor: [31, 111, 209, 255], getWidth: 3, widthUnits: "pixels" }),
        new ScatterplotLayer({ id: "draw-pts", data: draw, getPosition: (d) => [d.lon, d.lat], getRadius: 4, radiusUnits: "pixels", getFillColor: [31, 111, 209, 255] }),
        // кольцо магнита: зеленое - прилипнет к узлу, синее - встанет на линию дороги новым общим узлом
        new ScatterplotLayer({ id: "snap", data: snapMark && tool === "draw" ? [snapMark] : [], getPosition: (d) => [d.lon, d.lat], getRadius: 7, radiusUnits: "pixels", filled: false, stroked: true, getLineWidth: 2.5, lineWidthUnits: "pixels", getLineColor: (d) => (d.id !== null ? [40, 170, 90, 255] : [31, 111, 209, 255]) }),
    ].map((l) => l.clone({ parameters: flat }));
    overlay.setProps({
      // в 2D здания плоские и лежат под дорогами, в 3D объемные здания закрывают дороги за собой
      layers: view3d ? [...groundLayers, buildingsLayer, ...pointLayers, ...handleLayers] : [buildingsLayer, ...groundLayers, ...pointLayers, ...handleLayers],
    });
  }, [layersData, laneData, laneSel, lanesOn, heat, level, show, iconAtlas, selection, zoom, tool, check, draw, cursor, view3d, version, data, changes, dark, hlSet, lists, snapMark, routeData]);

  const hint: Record<string, string> = {
    select: "Клик выделяет дорогу или узел, узел можно перетащить. Shift+клик: несколько дорог или участок от выбранного узла до другого.",
    draw: "Кликайте точки новой дороги, к узлам прилипает. Enter или двойной клик - готово, Esc - отмена.",
    signal: "Клик по узлу дороги ставит или убирает светофор.",
    split: "Клик по среднему узлу дороги разрезает ее на две.",
    node: "Клик по линии дороги добавляет на нее новый узел.",
    join: selection?.kind === "node"
      ? "Шаг 2 из 2: кликните узел или дорогу, к которой присоединить выбранный узел. Esc - отмена."
      : "Шаг 1 из 2: кликните узел, который нужно присоединить (например, конец дороги).",
    unjoin: "Клик по узлу, где сходятся дороги, разъединяет их: у каждой дороги будет свой узел.",
    delete: "Клик по дороге или узлу удаляет его.",
  };

  return (
    <div className="mapwrap">
      <div ref={box} className="map" />
      {/* подсказка инструмента и панели под ней стоят столбиком и не налезают друг на друга */}
      {data && <div className="map-top">
        <div className="maphint">{hint[tool]}</div>
        {children}
      </div>}
      {data && <LayersPanel level={level} show={show} onLevel={setLevel} onShow={setShow} metroCount={layersData?.metroCount ?? 0} />}
      {data && showChanges && (
        <div className="legend">
          {changes.length === 0 ? "Правок пока нет" : (["added", "changed", "deleted"] as ChangeKind[]).map((k) => (
            <span key={k}><i style={{ background: `rgb(${CHANGE_COLORS[k].slice(0, 3).join(",")})` }} />{CHANGE_TEXT[k]}: {changes.filter((c) => c.kind === k).length}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export type { OsmWay };
