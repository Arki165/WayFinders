// Вкладка «Маршруты»: автобусы, троллейбусы, трамваи и маршрутки из файла.
// Клик по маршруту показывает его на карте: линия по дорогам и остановки по порядку.
import { useEffect, useMemo, useState } from "react";
import { useEditor } from "../model/store";
import { createRoute, deleteRoute, listRoutes, ROUTE_KINDS, ROUTE_RU, setRouteInfo, useRoute, type Route, type RouteKind } from "../model/routes";
import Icon from "./Icon";
import { locale, nameOf, toLatin, tr } from "../i18n";

const rgb = (c: [number, number, number]) => `rgb(${c.join(",")})`;
const km = (m: number) => (m / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 });

export default function RoutesPanel() {
  const data = useEditor((s) => s.data)!;
  const version = useEditor((s) => s.version);
  const routeId = useRoute((s) => s.id);
  const setRoute = useRoute((s) => s.set);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("all");
  const editing = useRoute((s) => s.editing);
  const edit = useRoute((s) => s.edit);
  const [creating, setCreating] = useState(false);
  // ушли с вкладки - правка маршрута заканчивается, клики по карте снова выделяют дороги
  useEffect(() => () => useRoute.getState().edit(false), []);

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

  const newBtn = <button className="route-new" onClick={() => setCreating(true)}><Icon name="plus" size={14} />{tr("Свой маршрут")}</button>;
  if (creating) return <div className="pane routes"><RouteForm title={tr("Новый маршрут")} onCancel={() => setCreating(false)} onSave={(k, ref) => { setCreating(false); setKind("all"); setQ(""); createRoute(k, ref); }} /></div>;

  if (!routes.length) {
    return (
      <div className="pane routes">
        <p className="hint">{tr("В файле нет маршрутов общественного транспорта. Они есть в файле-примере и скачиваются вместе с районом из OpenStreetMap (кнопка с глобусом вверху). Можно нарисовать свой маршрут.")}</p>
        {newBtn}
      </div>
    );
  }

  const count = (k: string) => routes.filter((r) => r.kind === k).length;
  return (
    <div className="pane routes">
      <div className="routes-top">
      <label className="routes-search">
        <Icon name="search" size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("Номер или остановка")} />
      </label>
      {newBtn}
      </div>
      <div className="seg routes-kinds">
        <button className={kind === "all" ? "on" : ""} onClick={() => setKind("all")}>{tr("Все")}{" "}{routes.length}</button>
        {ROUTE_KINDS.filter((k) => count(k)).map((k) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{ROUTE_RU[k]} {count(k)}</button>)}
      </div>

      {sel && (
        <div className="route-card">
          <div className="route-head">
            <span className="route-num" style={{ background: rgb(sel.color) }}>{toLatin(sel.ref)}</span>
            <b>{ROUTE_RU[sel.kind]} {toLatin(sel.ref)}{sel.custom && <small className="route-own">{tr("свой")}</small>}</b>
            {!editing && <button className="icon-btn" onClick={() => edit(true)} title={tr("Изменить маршрут: дороги, остановки, номер")}><Icon name="draw" size={14} /></button>}
            <button className="icon-btn" onClick={() => setRoute(null)} title={tr("Убрать маршрут с карты")}><Icon name="close" size={14} /></button>
          </div>
          <div className="sub">{toLatin(sel.name)}</div>
          <div className="sub">{km(sel.lengthM)} {" "}{tr("км по дорогам · остановок:")}{" "}{sel.stops.length}</div>
          {editing && (
            <div className="route-edit">
              <RouteForm key={sel.id} title="" initial={sel} onSave={(k, ref) => setRouteInfo(sel.id, k, ref)} saveLabel={tr("Сохранить")} />
              <p className="hint">{tr("Кликайте на карте дороги по порядку движения: дорога добавится в маршрут, повторный клик уберет ее. Так же кликайте значки остановок. Отменить: Ctrl+Z.")}</p>
              <div className="chips">
                <button className="on" onClick={() => edit(false)}>{tr("Готово")}</button>
                {sel.custom && <button className="danger" onClick={() => { if (confirm(tr("Удалить маршрут {0}?", sel.ref))) deleteRoute(sel.id); }}><Icon name="trash" size={14} />{tr("Удалить маршрут")}</button>}
              </div>
            </div>
          )}
          {sel.missing > 0 && <p className="hint">{tr("Часть маршрута за краем карты:")}{" "}{sel.missing} {" "}{tr("участков нет в файле.")}</p>}
          {sel.stops.length > 0 && (
            <ol className="route-stops">
              {sel.stops.map((id, i) => {
                const n = data.nodes.get(id);
                return <li key={id + ":" + i}><button onClick={() => { useEditor.getState().select({ kind: "node", id }); if (n) useEditor.getState().flyTo(n.lat, n.lon, 17.5); }}>{(n && nameOf(n.tags)) || tr("Остановка без названия")}</button></li>;
              })}
            </ol>
          )}
        </div>
      )}

      <div className="route-list">
        {shown.map((r) => (
          <button key={r.id} className={"route-item" + (r.id === routeId ? " on" : "")} onClick={() => pick(r)} title={tr("Показать на карте")}>
            <span className="route-num" style={{ background: rgb(r.color) }}>{toLatin(r.ref)}</span>
            <span className="route-text"><span>{toLatin(r.name)}</span><small>{ROUTE_RU[r.kind]} · {km(r.lengthM)} {" "}{tr("км ·")}{" "}{r.stops.length} {" "}{tr("ост.")}</small></span>
          </button>
        ))}
        {!shown.length && <p className="hint">{tr("Ничего не найдено")}</p>}
      </div>
    </div>
  );
}

// Форма маршрута: вид транспорта и номер. Начало и конец берутся из первой и последней остановки
function RouteForm({ title, initial, onSave, onCancel, saveLabel = tr("Создать и рисовать") }: { title: string; initial?: Route; onSave: (k: RouteKind, ref: string) => void; onCancel?: () => void; saveLabel?: string }) {
  const [k, setK] = useState<RouteKind>(initial?.kind ?? "bus");
  const [ref, setRef] = useState(initial?.ref ?? "");
  const ok = ref.trim() !== "" && (!initial || k !== initial.kind || ref.trim() !== initial.ref);
  return (
    <form className="route-form" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(k, ref.trim()); }}>
      {title && <h3>{title}</h3>}
      <label><span>{tr("Вид")}</span><select value={k} onChange={(e) => setK(e.target.value as RouteKind)}>{ROUTE_KINDS.map((x) => <option key={x} value={x}>{ROUTE_RU[x]}</option>)}</select></label>
      <label><span>{tr("Номер")}</span><input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={tr("например, 12к")} autoFocus={!initial} /></label>
      <div className="chips">
        <button type="submit" className="on" disabled={!ok}>{saveLabel}</button>
        {onCancel && <button type="button" onClick={onCancel}>{tr("Отмена")}</button>}
      </div>
      {!initial && <p className="hint">{tr("Дальше кликайте на карте дороги по порядку движения и значки остановок. Начало и конец маршрута - первая и последняя остановка.")}</p>}
    </form>
  );
}
