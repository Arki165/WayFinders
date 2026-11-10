import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// Фоновый поток MapLibre собираем отдельным файлом, иначе в Electron из файла он не грузится
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { useEditor, addWay, deleteNode, deleteWay, insertNode, joinNodes, joinNodeToWay, moveNodeDone, selectSection, setNodeTags, splitWay, toggleWay, unjoinNode } from "../model/store";
import { drivableNodeSet, isDrivable, isRoadSignal, lanesOf, roadClass } from "../model/roads";
import { calcWay, zLevel, Z_COLORS } from "../model/calc";
import { TEMPLATES } from "../model/templates";
import { changedRoads, CHANGE_COLORS, CHANGE_TEXT, type ChangeKind, type ChangedRoad } from "../model/changes";
import type { OsmWay } from "../osm/types";

export type Basemap = "map" | "satellite";

// Цвета подложки. В темной теме светлую схему переворачиваем по яркости, но не до черного,
// а в мягкий сине-серый; вода остается синей. В светлой подложка слегка приглушена, но не обесцвечена:
// здания на ней отличаются от земли оттенком, без цвета они пропадают.
const bgColor = (dark: boolean) => (dark ? "#1a2027" : "#e8e9e4");
function mapPaint(dark: boolean) {
  return dark
    ? { "raster-opacity": 0.85, "raster-saturation": -0.55, "raster-hue-rotate": 180, "raster-brightness-min": 0.8, "raster-brightness-max": 0.16 }
    : { "raster-opacity": 0.75, "raster-saturation": -0.15, "raster-hue-rotate": 0, "raster-brightness-min": 0, "raster-brightness-max": 1 };
}

// карта сразу создается в цветах текущей темы
const makeStyle = (dark: boolean): maplibregl.StyleSpecification => ({
  version: 8,
  sources: {
    map: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Esri, © OpenStreetMap" },
    satellite: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Esri World Imagery" },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": bgColor(dark) } },
    { id: "map", type: "raster", source: "map", paint: mapPaint(dark) },
    { id: "satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
  ],
});

maplibregl.setWorkerUrl(workerUrl);

// Перетаскивание узла: с какого приближения можно и через сколько пикселей начинается
const DRAG_MIN_ZOOM = 14;
const DRAG_START_PX = 4;

// Видимая область карты [юг, запад, север, восток] для загрузки района из OSM
let currentMap: maplibregl.Map | null = null;
export function getMapBounds(): [number, number, number, number] | null {
  if (!currentMap) return null;
  const b = currentMap.getBounds();
  return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
}

// Переключение темы перекрашивает уже созданную подложку
let darkMap = false;
function applyDark() {
  const map = currentMap;
  if (!map || !map.getLayer("map")) return;
  map.setPaintProperty("bg", "background-color", bgColor(darkMap));
  const p = mapPaint(darkMap);
  map.setPaintProperty("map", "raster-opacity", p["raster-opacity"]);
  map.setPaintProperty("map", "raster-saturation", p["raster-saturation"]);
  map.setPaintProperty("map", "raster-hue-rotate", p["raster-hue-rotate"]);
  map.setPaintProperty("map", "raster-brightness-min", p["raster-brightness-min"]);
  map.setPaintProperty("map", "raster-brightness-max", p["raster-brightness-max"]);
  map.triggerRepaint();
}

// В темной теме яркие дневные цвета дорог смешиваем с фоном, чтобы они не резали глаз
type Rgba = [number, number, number, number];
const DARK_BG = [26, 32, 39];
function soften(c: Rgba, dark: boolean): Rgba {
  if (!dark) return c;
  return [c[0] * 0.7 + DARK_BG[0] * 0.3, c[1] * 0.7 + DARK_BG[1] * 0.3, c[2] * 0.7 + DARK_BG[2] * 0.3, c[3]];
}

type RoadItem ={ id: number; path: [number, number, number][]; color: [number, number, number, number]; width: number };
type Pt = { id: number; pos: [number, number] };

interface Props {
  basemap: Basemap;
  view3d: boolean;
  heat: boolean;
  showBuildings: boolean;
  showChanges: boolean;
  drawTemplate: string;
  dark: boolean;
}

export default function MapView({ basemap, view3d, heat, showBuildings, showChanges, drawTemplate, dark }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [zoom, setZoom] = useState(15);
  const [draw, setDraw] = useState<{ id: number | null; lat: number; lon: number }[]>([]);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const dragRef = useRef<{ id: number; from: [number, number]; moved: boolean; start: [number, number] } | null>(null);

  const data = useEditor((s) => s.data);
  const original = useEditor((s) => s.original);
  const version = useEditor((s) => s.version);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const check = useEditor((s) => s.check);
  const focus = useEditor((s) => s.focus);
  const norms = useEditor((s) => s.norms);
  const highlight = useEditor((s) => s.highlight);

  // актуальные значения для обработчиков событий карты
  const live = useRef({ tool, draw, selection, drawTemplate, dark });
  live.current = { tool, draw, selection, drawTemplate, dark };

  // ---------- создание карты ----------
  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({ container: box.current, style: makeStyle(live.current.dark), center: [104.262, 52.262], zoom: 15, maxPitch: 70, doubleClickZoom: false, boxZoom: false }); // Shift+клик нужен для выделения, рамка приближения его перехватывала
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);
    mapRef.current = map;
    currentMap = map;
    overlayRef.current = overlay;
    map.on("zoomend", () => setZoom(map.getZoom()));

    const pick = (x: number, y: number, layerIds?: string[]) => overlay.pickObject({ x, y, radius: 6, layerIds });

    map.on("mousedown", (e) => {
      // с Shift узел не таскаем: Shift+клик выделяет участок между узлами
      if (live.current.tool !== "select" || e.originalEvent.shiftKey) return;
      // при сильном отдалении узлы не таскаем: 1 пиксель там - километры, дрожание мыши уносило узел в другой город
      if (map.getZoom() < DRAG_MIN_ZOOM) return;
      const info = pick(e.point.x, e.point.y, ["nodes", "signals"]);
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
        const n = st.data.nodes.get(dr.id);
        if (n) { n.lat = e.lngLat.lat; n.lon = e.lngLat.lng; dr.moved = true; st.bump(); }
        return;
      }
      if (live.current.tool === "draw" && live.current.draw.length) setCursor([e.lngLat.lng, e.lngLat.lat]);
    });
    map.on("mouseup", () => {
      const dr = dragRef.current;
      if (!dr) return;
      dragRef.current = null;
      map.dragPan.enable();
      if (dr.moved) moveNodeDone(dr.id, dr.from);
    });

    map.on("click", (e) => {
      const st = useEditor.getState();
      if (!st.data) return;
      const t = live.current.tool;
      // узел под курсором важнее круга ошибки вокруг него: иначе узел разорванного перекрестка не выбрать;
      // в инструментах правки круги ошибок вообще не перехватывают клики
      const onNode = pick(e.point.x, e.point.y, ["nodes", "signals"]);
      const info = onNode?.object ? onNode : t === "select" ? pick(e.point.x, e.point.y) : pick(e.point.x, e.point.y, ["roads", "others", "crossings"]);
      const layer = info?.layer?.id;
      const obj = info?.object as (RoadItem & Pt & { key: string }) | undefined;
      if (layer === "errors" && obj) {
        const er = st.check?.errors.find((x) => x.key === obj.key);
        if (er) { st.setHighlight(er.ways); st.select(er.ways.length ? { kind: "way", id: er.ways[0] } : null); }
        return;
      }
      const nodeId = layer === "nodes" || layer === "signals" ? obj!.id : null;
      const wayId = layer === "roads" || layer === "others" || layer === "crossings" ? obj!.id : null;
      const shift = (e.originalEvent as MouseEvent).shiftKey;
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
        if (nodeId === null && wayId === null) st.setHighlight([]);
      } else if (t === "draw") {
        const p = nodeId !== null ? st.data.nodes.get(nodeId)! : null;
        setDraw((d) => [...d, p ? { id: p.id, lat: p.lat, lon: p.lon } : { id: null, lat: e.lngLat.lat, lon: e.lngLat.lng }]);
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
        if (tags.highway === "traffic_signals") { delete tags.highway; setNodeTags(nodeId, tags, "Светофор убран"); }
        else { tags.highway = "traffic_signals"; setNodeTags(nodeId, tags, "Светофор добавлен"); }
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
    return () => map.remove();
  }, []);

  function finishDraw() {
    const pts = live.current.draw;
    setDraw([]);
    setCursor(null);
    if (pts.length < 2) return useEditor.getState().toast("Нужно минимум две точки");
    const tpl = TEMPLATES[live.current.drawTemplate] ?? TEMPLATES.secondary;
    addWay(pts, tpl.tags);
    useEditor.getState().toast(`Дорога добавлена по шаблону «${tpl.name}»`);
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
  useEffect(() => { if (tool !== "draw") { setDraw([]); setCursor(null); } }, [tool]);

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
  useEffect(() => { darkMap = dark; applyDark(); }, [dark]);
  useEffect(() => { mapRef.current?.easeTo({ pitch: view3d ? 55 : 0, bearing: view3d ? -20 : 0, duration: 600 }); }, [view3d]);
  useEffect(() => { if (focus) mapRef.current?.flyTo({ center: [focus.lon, focus.lat], zoom: focus.zoom ?? Math.max(mapRef.current.getZoom(), 17), duration: 700 }); }, [focus]);
  useEffect(() => {
    const b = data?.bounds;
    if (b && mapRef.current) mapRef.current.fitBounds([[b.minlon, b.minlat], [b.maxlon, b.maxlat]], { padding: 30, duration: 0 });
  }, [original]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- данные для слоев ----------
  const layersData = useMemo(() => {
    if (!data) return null;
    const onRoad = drivableNodeSet(data);
    type Line = { id: number; path: [number, number][]; color: [number, number, number, number]; width: number };
    // переходы рисуются поверх дорог, остальные линии под ними
    const roads: RoadItem[] = [], others: Line[] = [], crossings: Line[] = [], buildings: { poly: [number, number][]; h: number }[] = [];
    const deg = new Map<number, number>();
    const hl = new Set(highlight);
    const ways = [...data.ways.values()];
    const coord = (id: number): [number, number] => { const n = data.nodes.get(id)!; return [n.lon, n.lat]; };
    for (const w of ways) {
      if (w.nodeIds.length < 2) continue;
      if (isDrivable(w)) {
        for (const id of w.nodeIds) deg.set(id, (deg.get(id) ?? 0) + 1);
        const lvl = parseInt(w.tags.layer ?? "0", 10) || 0;
        const z = w.tags.bridge === "yes" ? Math.max(1, lvl) * 6 : 0;
        const path = w.nodeIds.map((id, i): [number, number, number] => { const c = coord(id); return [c[0], c[1], i === 0 || i === w.nodeIds.length - 1 ? 0 : z]; });
        let color: [number, number, number, number] = [...roadClass(w).color, 255];
        if (heat) { const c = calcWay(data, w, norms); color = c.Z !== null ? [...Z_COLORS[zLevel(c.Z, norms)], 255] : [180, 180, 180, 160]; }
        if (w.tags.tunnel === "yes") color = [color[0], color[1], color[2], 110];
        if (hl.has(w.id)) color = [150, 90, 220, 255];
        roads.push({ id: w.id, path, color, width: lanesOf(w) * 3.2 });
      } else if (w.tags.building && showBuildings) {
        const lv = parseFloat(w.tags["building:levels"] ?? "") || 3;
        buildings.push({ poly: w.nodeIds.map(coord), h: lv * 3 });
      } else if (w.tags.highway || w.tags.railway) {
        const rail = !!w.tags.railway;
        // рельсы и переходы толще: их выбирают кликом
        const cross = w.tags.footway === "crossing";
        (cross ? crossings : others).push({ id: w.id, path: w.nodeIds.map(coord), color: hl.has(w.id) ? [150, 90, 220, 255] : rail ? [130, 100, 160, 230] : cross ? [60, 60, 60, 220] : [150, 130, 115, 150], width: rail ? 3 : cross ? 3 : 1 });
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
    return { roads, others, crossings, buildings, junctions, signals, arrows };
  }, [data, version, heat, norms, showBuildings, highlight]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- правки относительно исходного файла ----------
  const changes = useMemo(() => {
    if (!data || !original || !showChanges) return [];
    return changedRoads(original, data);
  }, [data, original, version, showChanges]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- слои deck.gl ----------
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!data || !layersData) { overlay.setProps({ layers: [] }); return; }
    const selWay = selection?.kind === "way" ? data.ways.get(selection.id) : undefined;
    const selIds = new Set(selection?.kind === "ways" ? selection.ids : []);
    const section = selection?.kind === "ways" && selection.section ? selection.section : null;
    const sectionPath = section ? section.nodes.map((id) => data.nodes.get(id)).filter(Boolean).map((n) => [n!.lon, n!.lat] as [number, number]) : [];
    const selNode = selection?.kind === "node" ? selection.id : null;
    const showNodes = zoom >= 16.5 || tool !== "select";
    const vertIds = selWay ? selWay.nodeIds : section ? [section.from, section.to] : [];
    const vertices: Pt[] = vertIds.filter((id) => data.nodes.has(id)).map((id) => { const n = data.nodes.get(id)!; return { id, pos: [n.lon, n.lat] as [number, number] }; });
    const nodes = showNodes && zoom >= 15.5 ? [...layersData.junctions, ...vertices] : vertices;
    const errs = check?.errors ?? [];
    const drawPath = draw.map((p) => [p.lon, p.lat] as [number, number]);
    if (cursor && drawPath.length) drawPath.push(cursor);

    // Плоские слои лежат на одной высоте: если сравнивать их глубину, в наклонном 3D они мерцают полосами.
    // Поэтому они рисуются просто по порядку, а глубину учитывают только объемные здания.
    const flat = { depthCompare: "always" as const, depthWriteEnabled: false };
    const buildingsLayer = new PolygonLayer({ id: "buildings", data: layersData.buildings, getPolygon: (d) => d.poly, extruded: view3d, getElevation: (d) => d.h, getFillColor: dark ? [62, 72, 86, view3d ? 235 : 190] : [200, 196, 186, view3d ? 230 : 140], getLineColor: dark ? [92, 104, 120, 220] : [170, 165, 155, 200], lineWidthMinPixels: 0.5, stroked: !view3d });
    const groundLayers = [
        new PathLayer({ id: "others", data: layersData.others, getPath: (d) => d.path, getColor: (d) => (d.id === selWay?.id ? [31, 111, 209, 255] : soften(d.color, dark)), getWidth: (d) => (d.id === selWay?.id ? d.width + 2 : d.width), widthUnits: "pixels", widthMinPixels: 1, pickable: true, updateTriggers: { getColor: [dark, selWay?.id], getWidth: selWay?.id } }),
        // широкая цветная подложка под измененными дорогами
        new PathLayer<ChangedRoad>({ id: "changes", data: changes, getPath: (d) => d.path, getColor: (d) => CHANGE_COLORS[d.kind], getWidth: 14, widthUnits: "pixels", capRounded: true, jointRounded: true }),
        new PathLayer<RoadItem>({ id: "roads-casing", data: layersData.roads, getPath: (d) => d.path, getColor: dark ? [10, 13, 17, 230] : [90, 90, 85, 200], getWidth: (d) => d.width + 1.6, widthUnits: "meters", widthMinPixels: 3, capRounded: true, jointRounded: true }),
        new PathLayer<RoadItem>({
          id: "roads", data: layersData.roads, getPath: (d) => d.path,
          getColor: (d) => (d.id === selWay?.id || (selIds.has(d.id) && !section) ? [31, 111, 209, 255] : soften(d.color, dark)), getWidth: (d) => d.width, widthUnits: "meters", widthMinPixels: 2,
          capRounded: true, jointRounded: true, pickable: true, autoHighlight: true, highlightColor: [31, 111, 209, 120],
          updateTriggers: { getColor: [selWay?.id, version, dark, selection] },
        }),
        new PathLayer({ id: "crossings", data: layersData.crossings, getPath: (d) => d.path, getColor: (d) => (d.id === selWay?.id ? [31, 111, 209, 255] : soften(d.color, dark)), getWidth: 3, widthUnits: "pixels", pickable: true, updateTriggers: { getColor: [dark, selWay?.id] } }),
        new TextLayer({ id: "arrows", data: zoom >= 16 ? layersData.arrows : [], getPosition: (d) => d.pos, getText: () => "▶", getAngle: (d) => d.angle, getSize: 11, getColor: dark ? [225, 230, 236, 220] : [40, 40, 40, 220], characterSet: ["▶"], billboard: false }),
    ].map((l) => l.clone({ parameters: flat }));
    const pointLayers = [
        new ScatterplotLayer<Pt>({ id: "nodes", data: nodes, getPosition: (d) => d.pos, getRadius: (d) => (d.id === selNode ? 6 : 3.5), radiusUnits: "pixels", getFillColor: (d) => (d.id === selNode ? [31, 111, 209, 255] : [255, 255, 255, 255]), getLineColor: [31, 111, 209, 255], stroked: true, lineWidthMinPixels: 1.5, pickable: true, updateTriggers: { getRadius: selNode, getFillColor: selNode } }),
        new ScatterplotLayer<Pt>({ id: "signals", data: layersData.signals, getPosition: (d) => d.pos, getRadius: 6, radiusUnits: "pixels", getFillColor: [229, 72, 63, 255], getLineColor: [255, 255, 255, 255], stroked: true, lineWidthMinPixels: 2, pickable: true }),
        new ScatterplotLayer({ id: "errors", data: errs, getPosition: (d) => [d.lon, d.lat], getRadius: (d) => (d.type === "trap" || d.type === "isolated" ? 16 : 11), radiusUnits: "pixels", filled: true, getFillColor: (d) => (d.sev === "danger" ? [216, 64, 47, 40] : d.sev === "warn" ? [229, 154, 40, 40] : [61, 107, 143, 40]), getLineColor: (d) => (d.sev === "danger" ? [216, 64, 47, 255] : d.sev === "warn" ? [229, 154, 40, 255] : [61, 107, 143, 255]), stroked: true, lineWidthMinPixels: 2, pickable: true }),
        // участок между двумя узлами (Shift+клик по второму узлу)
        new PathLayer({ id: "section", data: sectionPath.length > 1 ? [{ path: sectionPath }] : [], getPath: (d) => d.path, getColor: [31, 111, 209, 230], getWidth: 7, widthUnits: "pixels", capRounded: true, jointRounded: true }),
        new PathLayer({ id: "draw", data: drawPath.length > 1 ? [{ path: drawPath }] : [], getPath: (d) => d.path, getColor: [31, 111, 209, 255], getWidth: 3, widthUnits: "pixels" }),
        new ScatterplotLayer({ id: "draw-pts", data: draw, getPosition: (d) => [d.lon, d.lat], getRadius: 4, radiusUnits: "pixels", getFillColor: [31, 111, 209, 255] }),
    ].map((l) => l.clone({ parameters: flat }));
    overlay.setProps({
      // в 2D здания плоские и лежат под дорогами, в 3D объемные здания закрывают дороги за собой
      layers: view3d ? [...groundLayers, buildingsLayer, ...pointLayers] : [buildingsLayer, ...groundLayers, ...pointLayers],
    });
  }, [layersData, selection, zoom, tool, check, draw, cursor, view3d, version, data, changes, dark]);

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
      {data && <div className="maphint">{hint[tool]}</div>}
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
