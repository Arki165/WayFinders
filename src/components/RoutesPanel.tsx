// Вкладка «Маршруты»: автобусы, троллейбусы, трамваи и маршрутки из файла.
// Клик по маршруту показывает его на карте: линия по дорогам и остановки по порядку.
import { useMemo, useState } from "react";
import { useEditor } from "../model/store";
import { listRoutes, ROUTE_KINDS, ROUTE_RU, useRoute, type Route } from "../model/routes";
import Icon from "./Icon";

const rgb = (c: [number, number, number]) => `rgb(${c.join(",")})`;
const km = (m: number) => (m / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 });

export default function RoutesPanel() {
  const data = useEditor((s) => s.data)!;
  const version = useEditor((s) => s.version);
  const routeId = useRoute((s) => s.id);
  const setRoute = useRoute((s) => s.set);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("all");

  const routes = useMemo(() => listRoutes(data), [data, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
  const shown = routes.filter((r) => (kind === "all" || r.kind === kind) && (!q || norm(r.ref).startsWith(norm(q)) || norm(r.name).includes(norm(q))));
  const sel = routes.find((r) => r.id === routeId);

  // выбрать маршрут и показать его на карте целиком
  function pick(r: Route) {
    if (r.id === routeId) return setRoute(null);
    setRoute(r.id);
    let w = 180, s = 90, e = -180, n = -90;
    for (const id of r.ways) for (const nid of data.ways.get(id)?.nodeIds ?? []) {
      const p = data.nodes.get(nid);
      if (p) { w = Math.min(w, p.lon); s = Math.min(s, p.lat); e = Math.max(e, p.lon); n = Math.max(n, p.lat); }
    }
    if (w <= e) useEditor.getState().fitTo([w, s, e, n]);
  }

  if (!routes.length) {
    return (
      <div className="pane">
        <p className="hint">В файле нет маршрутов общественного транспорта. Они есть в файле-примере и скачиваются вместе с районом из OpenStreetMap (кнопка с глобусом вверху).</p>
      </div>
    );
  }

  const count = (k: string) => routes.filter((r) => r.kind === k).length;
  return (
    <div className="pane routes">
      <label className="routes-search">
        <Icon name="search" size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Номер или остановка" />
      </label>
      <div className="seg routes-kinds">
        <button className={kind === "all" ? "on" : ""} onClick={() => setKind("all")}>Все {routes.length}</button>
        {ROUTE_KINDS.filter((k) => count(k)).map((k) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{ROUTE_RU[k]} {count(k)}</button>)}
      </div>

      {sel && (
        <div className="route-card">
          <div className="route-head">
            <span className="route-num" style={{ background: rgb(sel.color) }}>{sel.ref}</span>
            <b>{ROUTE_RU[sel.kind]} {sel.ref}</b>
            <button className="icon-btn" onClick={() => setRoute(null)} title="Убрать маршрут с карты"><Icon name="close" size={14} /></button>
          </div>
          <div className="sub">{sel.name}</div>
          <div className="sub">{km(sel.lengthM)} км по дорогам · остановок: {sel.stops.length}</div>
          {sel.missing > 0 && <p className="hint">Часть маршрута за краем карты: {sel.missing} участков нет в файле.</p>}
          {sel.stops.length > 0 && (
            <ol className="route-stops">
              {sel.stops.map((id, i) => {
                const n = data.nodes.get(id);
                return <li key={id + ":" + i}><button onClick={() => { useEditor.getState().select({ kind: "node", id }); if (n) useEditor.getState().flyTo(n.lat, n.lon, 17.5); }}>{n?.tags.name || "Остановка без названия"}</button></li>;
              })}
            </ol>
          )}
        </div>
      )}

      <div className="route-list">
        {shown.map((r) => (
          <button key={r.id} className={"route-item" + (r.id === routeId ? " on" : "")} onClick={() => pick(r)} title="Показать на карте">
            <span className="route-num" style={{ background: rgb(r.color) }}>{r.ref}</span>
            <span className="route-text"><span>{r.name}</span><small>{ROUTE_RU[r.kind]} · {km(r.lengthM)} км · {r.stops.length} ост.</small></span>
          </button>
        ))}
        {!shown.length && <p className="hint">Ничего не найдено</p>}
      </div>
    </div>
  );
}
