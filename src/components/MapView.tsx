import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// Фоновый поток MapLibre собираем отдельным файлом, иначе в Electron из файла он не грузится
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { useEditor, addWay, deleteNode, deleteWay, moveNodeDone, setNodeTags, splitWay } from "../model/store";
import { drivableNodeSet, isDrivable, isRoadSignal, lanesOf, roadClass } from "../model/roads";
import { calcWay, zLevel, Z_COLORS } from "../model/calc";
import { TEMPLATES } from "../model/templates";
import type { OsmWay } from "../osm/types";

export type Basemap = "map" | "satellite";

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    map: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, attribution: "Esri, © OpenStreetMap" },
    satellite: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, attribution: "Esri World Imagery" },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#e8e9e4" } },
    { id: "map", type: "raster", source: "map", paint: { "raster-opacity": 0.55, "raster-saturation": -0.6 } },
    { id: "satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
  ],
};

maplibregl.setWorkerUrl(workerUrl);

// Видимая область карты [юг, запад, север, восток] для загрузки района из OSM
let currentMap: maplibregl.Map | null = null;
export function getMapBounds(): [number, number, number, number] | null {
  if (!currentMap) return null;
  const b = currentMap.getBounds();
  return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
}

// Темная тема: светлую схему переворачиваем по яркости, вода остается синей
let darkMap = false;
function applyDark() {
  const map = currentMap;
  if (!map || !map.isStyleLoaded()) return;
  map.setPaintProperty("bg", "background-color", darkMap ? "#1b1e1c" : "#e8e9e4");
  map.setPaintProperty("map", "raster-brightness-min", darkMap ? 1 : 0);
  map.setPaintProperty("map", "raster-brightness-max", darkMap ? 0 : 1);
  map.setPaintProperty("map", "raster-hue-rotate", darkMap ? 180 : 0);
}
export function setMapDark(dark: boolean) {
  darkMap = dark;
  applyDark();
}

type RoadItem ={ id: number; path: [number, number, number][]; color: [number, number, number, number]; width: number };
type Pt = { id: number; pos: [number, number] };

interface Props {
  basemap: Basemap;
  view3d: boolean;
  heat: boolean;
  showBuildings: boolean;
  drawTemplate: string;
}

export default function MapView({ basemap, view3d, heat, showBuildings, drawTemplate }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [zoom, setZoom] = useState(15);
  const [draw, setDraw] = useState<{ id: number | null; lat: number; lon: number }[]>([]);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const dragRef = useRef<{ id: number; from: [number, number]; moved: boolean } | null>(null);

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
  const live = useRef({ tool, draw, selection, drawTemplate });
  live.current = { tool, draw, selection, drawTemplate };

  // ---------- создание карты ----------
  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({ container: box.current, style: STYLE, center: [104.262, 52.262], zoom: 15, maxPitch: 70, doubleClickZoom: false });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);
    mapRef.current = map;
    currentMap = map;
    map.on("load", applyDark);
    overlayRef.current = overlay;
    map.on("zoomend", () => setZoom(map.getZoom()));

    const pick = (x: number, y: number, layerIds?: string[]) => overlay.pickObject({ x, y, radius: 6, layerIds });

    map.on("mousedown", (e) => {
      if (live.current.tool !== "select") return;
      const info = pick(e.point.x, e.point.y, ["nodes", "signals"]);
      if (!info?.object) return;
      const id = (info.object as Pt).id;
      const n = useEditor.getState().data?.nodes.get(id);
      if (!n) return;
      e.preventDefault();
      map.dragPan.disable();
      dragRef.current = { id, from: [n.lat, n.lon], moved: false };
      useEditor.getState().select({ kind: "node", id });
    });
    map.on("mousemove", (e) => {
      const st = useEditor.getState();
      if (dragRef.current && st.data) {
        const n = st.data.nodes.get(dragRef.current.id);
        if (n) { n.lat = e.lngLat.lat; n.lon = e.lngLat.lng; dragRef.current.moved = true; st.bump(); }
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
      const info = pick(e.point.x, e.point.y);
      const layer = info?.layer?.id;
      const obj = info?.object as (RoadItem & Pt & { key: string }) | undefined;
      if (layer === "errors" && obj) {
        const er = st.check?.errors.find((x) => x.key === obj.key);
        if (er) { st.setHighlight(er.ways); st.select(er.ways.length ? { kind: "way", id: er.ways[0] } : null); }
        return;
      }
      const nodeId = layer === "nodes" || layer === "signals" ? obj!.id : null;
      const wayId = layer === "roads" ? obj!.id : null;
      if (t === "select") {
        st.select(nodeId !== null ? { kind: "node", id: nodeId } : wayId !== null ? { kind: "way", id: wayId } : null);
        if (nodeId === null && wayId === null) st.setHighlight([]);
      } else if (t === "draw") {
        const p = nodeId !== null ? st.data.nodes.get(nodeId)! : null;
        setDraw((d) => [...d, p ? { id: p.id, lat: p.lat, lon: p.lon } : { id: null, lat: e.lngLat.lat, lon: e.lngLat.lng }]);
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
    if (map.isStyleLoaded()) apply(); else map.once("load", apply);
  }, [basemap]);
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
    const roads: RoadItem[] = [], others: { path: [number, number][]; color: [number, number, number, number]; width: number }[] = [], buildings: { poly: [number, number][]; h: number }[] = [];
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
        others.push({ path: w.nodeIds.map(coord), color: rail ? [130, 100, 160, 220] : [150, 130, 115, 150], width: rail ? 2 : 1 });
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
    return { roads, others, buildings, junctions, signals, arrows };
  }, [data, version, heat, norms, showBuildings, highlight]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- слои deck.gl ----------
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!data || !layersData) { overlay.setProps({ layers: [] }); return; }
    const selWay = selection?.kind === "way" ? data.ways.get(selection.id) : undefined;
    const selNode = selection?.kind === "node" ? selection.id : null;
    const showNodes = zoom >= 16.5 || tool !== "select";
    const vertices: Pt[] = selWay ? selWay.nodeIds.map((id) => { const n = data.nodes.get(id)!; return { id, pos: [n.lon, n.lat] as [number, number] }; }) : [];
    const nodes = showNodes && zoom >= 15.5 ? [...layersData.junctions, ...vertices] : vertices;
    const errs = check?.errors ?? [];
    const drawPath = draw.map((p) => [p.lon, p.lat] as [number, number]);
    if (cursor && drawPath.length) drawPath.push(cursor);

    overlay.setProps({
      layers: [
        new PolygonLayer({ id: "buildings", data: layersData.buildings, getPolygon: (d) => d.poly, extruded: view3d, getElevation: (d) => d.h, getFillColor: [200, 196, 186, view3d ? 230 : 140], getLineColor: [170, 165, 155, 200], lineWidthMinPixels: 0.5, stroked: !view3d }),
        new PathLayer({ id: "others", data: layersData.others, getPath: (d) => d.path, getColor: (d) => d.color, getWidth: (d) => d.width, widthUnits: "pixels" }),
        new PathLayer<RoadItem>({ id: "roads-casing", data: layersData.roads, getPath: (d) => d.path, getColor: [90, 90, 85, 200], getWidth: (d) => d.width + 1.6, widthUnits: "meters", widthMinPixels: 3, capRounded: true, jointRounded: true }),
        new PathLayer<RoadItem>({
          id: "roads", data: layersData.roads, getPath: (d) => d.path,
          getColor: (d) => (d.id === selWay?.id ? [31, 111, 209, 255] : d.color), getWidth: (d) => d.width, widthUnits: "meters", widthMinPixels: 2,
          capRounded: true, jointRounded: true, pickable: true, autoHighlight: true, highlightColor: [31, 111, 209, 120],
          updateTriggers: { getColor: [selWay?.id, version] },
        }),
        new TextLayer({ id: "arrows", data: zoom >= 16 ? layersData.arrows : [], getPosition: (d) => d.pos, getText: () => "▶", getAngle: (d) => d.angle, getSize: 11, getColor: [40, 40, 40, 220], characterSet: ["▶"], billboard: false }),
        new ScatterplotLayer<Pt>({ id: "nodes", data: nodes, getPosition: (d) => d.pos, getRadius: (d) => (d.id === selNode ? 6 : 3.5), radiusUnits: "pixels", getFillColor: (d) => (d.id === selNode ? [31, 111, 209, 255] : [255, 255, 255, 255]), getLineColor: [31, 111, 209, 255], stroked: true, lineWidthMinPixels: 1.5, pickable: true, updateTriggers: { getRadius: selNode, getFillColor: selNode } }),
        new ScatterplotLayer<Pt>({ id: "signals", data: layersData.signals, getPosition: (d) => d.pos, getRadius: 6, radiusUnits: "pixels", getFillColor: [229, 72, 63, 255], getLineColor: [255, 255, 255, 255], stroked: true, lineWidthMinPixels: 2, pickable: true }),
        new ScatterplotLayer({ id: "errors", data: errs, getPosition: (d) => [d.lon, d.lat], getRadius: (d) => (d.type === "trap" || d.type === "isolated" ? 16 : 11), radiusUnits: "pixels", filled: true, getFillColor: (d) => (d.sev === "danger" ? [216, 64, 47, 40] : d.sev === "warn" ? [229, 154, 40, 40] : [61, 107, 143, 40]), getLineColor: (d) => (d.sev === "danger" ? [216, 64, 47, 255] : d.sev === "warn" ? [229, 154, 40, 255] : [61, 107, 143, 255]), stroked: true, lineWidthMinPixels: 2, pickable: true }),
        new PathLayer({ id: "draw", data: drawPath.length > 1 ? [{ path: drawPath }] : [], getPath: (d) => d.path, getColor: [31, 111, 209, 255], getWidth: 3, widthUnits: "pixels" }),
        new ScatterplotLayer({ id: "draw-pts", data: draw, getPosition: (d) => [d.lon, d.lat], getRadius: 4, radiusUnits: "pixels", getFillColor: [31, 111, 209, 255] }),
      ],
    });
  }, [layersData, selection, zoom, tool, check, draw, cursor, view3d, version, data]);

  const hint: Record<string, string> = {
    select: "Клик выделяет дорогу или узел. Узел можно перетащить. При сильном приближении видны все узлы.",
    draw: "Кликайте точки новой дороги, к узлам прилипает. Enter или двойной клик - готово, Esc - отмена.",
    signal: "Клик по узлу дороги ставит или убирает светофор.",
    split: "Клик по среднему узлу дороги разрезает ее на две.",
    delete: "Клик по дороге или узлу удаляет его.",
  };

  return (
    <div className="mapwrap">
      <div ref={box} className="map" />
      {data && <div className="maphint">{hint[tool]}</div>}
    </div>
  );
}

export type { OsmWay };
