// Панель полос выбранной дороги: схема поперек дороги и свойства выбранной полосы
import { setWayTags } from "../model/store";
import { addLane, crossOrDefault, getLanes, lanesToTags, setCross, setDir, useLane, TURNS, LANE_WIDTH, type Lane, type LaneKind, type Lanes } from "../model/lanes";
import { maxSpeed } from "../model/roads";
import { DirIcon, TurnIcon } from "./turnIcons";
import type { OsmWay } from "../osm/types";
import { tr } from "../i18n";

const KINDS: [LaneKind, string][] = [["general", "Общая"], ["bus", "Автобус"], ["bicycle", "Велосипед"]];
const SPEEDS = ["20", "30", "40", "50", "60", "70", "80", "90"];
const WIDTHS = ["1.5", "2.75", "3", "3.25", "3.5", "3.75"];

export default function LanePanel({ way }: { way: OsmWay }) {
  const sel = useLane((s) => s.sel);
  const setSel = useLane((s) => s.setSel);
  const lanes = getLanes(way);
  const index = sel?.wayId === way.id && sel.index < lanes.length ? sel.index : null;
  const lane = index !== null ? lanes[index] : null;

  const save = (next: Lanes, label: string, idx: number | null = index) => {
    setWayTags(way.id, lanesToTags(way, next), label);
    setSel(idx === null ? null : { wayId: way.id, index: idx });
  };
  const edit = (patch: Partial<Lane>, label: string) => save(lanes.map((l, i) => (i === index ? { ...l, ...patch } : l)), label);

  // стороны по ходу движения полосы -> стороны поперек дороги
  const crossOf = (side: "left" | "right"): "L" | "R" => ((side === "left") === (lane?.dir === "forward") ? "L" : "R");
  const neighbor = (side: "left" | "right") => (index === null ? undefined : lanes[crossOf(side) === "L" ? index - 1 : index + 1]);

  const toggleTurn = (t: string) => {
    const cur = lane!.turn ? lane!.turn.split(";").filter((x) => x && x !== "none") : [];
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
    const order = TURNS.map((x) => x[0]);
    next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    edit({ turn: next.join(";") }, tr("Поворот с полосы"));
  };

  return (
    <div className="lanes-box">
      <h3>{tr("Полосы по отдельности")}</h3>
      <div className="lanes-strip" title={tr("Схема поперек дороги, если смотреть по направлению линии")}>
        {lanes.map((l, i) => (
          <button key={i} className={`lane-btn k-${l.kind}${i === index ? " on" : ""}`} onClick={() => setSel(i === index ? null : { wayId: way.id, index: i })} title={(l.dir === "forward" ? tr("Туда") : tr("Обратно")) + (l.turn ? ", " + l.turn : "")}>
            <b><DirIcon back={l.dir !== "forward"} /></b>
            <small>{l.turn ? <TurnIcon turn={l.turn} size={14} /> : "·"}</small>
          </button>
        ))}
      </div>
      <div className="chips">
        <button onClick={() => { const r = addLane(lanes, "backward"); save(r.lanes, tr("Полоса добавлена"), r.index); }} title={tr("Добавить полосу против направления линии (слева)")}>{tr("+ Обратно")}</button>
        <button onClick={() => { const r = addLane(lanes, "forward"); save(r.lanes, tr("Полоса добавлена"), r.index); }} title={tr("Добавить полосу по направлению линии (справа)")}>{tr("+ Туда")}</button>
        <button className="danger" disabled={index === null || lanes.length < 2} onClick={() => save(lanes.filter((_, i) => i !== index), tr("Полоса удалена"), null)}>{tr("Удалить полосу")}</button>
      </div>

      {!lane && <p className="hint">{tr("Выберите полосу на схеме или кликните по ней на карте (полосы видны с масштаба 100 м).")}</p>}
      {lane && (
        <div className="form">
          <span>{tr("Направление")}</span>
          <div className="seg">
            {(["forward", "backward"] as const).map((d) => (
              <button key={d} className={lane.dir === d ? "on" : ""} onClick={() => { if (lane.dir === d) return; const r = setDir(lanes, index!, d); save(r.lanes, tr("Направление полосы"), r.index); }}><DirIcon back={d !== "forward"} />{d === "forward" ? tr("Туда") : tr("Обратно")}</button>
            ))}
          </div>
          <span>{tr("Поворот")}</span>
          <div className="seg">
            {TURNS.map(([t, name]) => (
              <button key={t} title={tr(name)} className={lane.turn.split(";").includes(t) ? "on" : ""} onClick={() => toggleTurn(t)}><TurnIcon turn={t} /></button>
            ))}
          </div>
          {(["left", "right"] as const).map((side) => {
            const nb = neighbor(side);
            const allow = crossOrDefault(lanes, index!, crossOf(side));
            return [
              <span key={side + "l"}>{side === "left" ? tr("Линия слева") : tr("Линия справа")}</span>,
              nb ? (
                <div key={side} className="seg">
                  <button className={allow === true ? "on" : ""} title={tr("Перестраиваться можно")} onClick={() => save(setCross(lanes, index!, crossOf(side), true), tr("Разметка: прерывистая"))}>{tr("Прерывистая")}</button>
                  <button className={allow === false ? "on" : ""} title={tr("Перестраиваться нельзя")} onClick={() => save(setCross(lanes, index!, crossOf(side), false), tr("Разметка: сплошная"))}>{tr("Сплошная")}</button>
                </div>
              ) : <span key={side} className="muted">{tr("край дороги")}</span>,
            ];
          })}
          <span>{tr("Тип")}</span>
          <div className="seg">
            {KINDS.map(([k, name]) => <button key={k} className={lane.kind === k ? "on" : ""} onClick={() => edit({ kind: k }, tr("Тип полосы: ") + tr(name))}>{tr(name)}</button>)}
          </div>
          <span>{tr("Скорость")}</span>
          <select value={lane.speed} onChange={(e) => edit({ speed: e.target.value }, tr("Скорость полосы"))}>
            <option value="">{tr("как у дороги (")}{maxSpeed(way)})</option>
            {SPEEDS.map((v) => <option key={v} value={v}>{v} {" "}{tr("км/ч")}</option>)}
            {lane.speed && !SPEEDS.includes(lane.speed) && <option value={lane.speed}>{lane.speed}</option>}
          </select>
          <span>{tr("Ширина")}</span>
          <select value={lane.width} onChange={(e) => edit({ width: e.target.value }, tr("Ширина полосы"))}>
            <option value="">{tr("по умолчанию (")}{lane.kind === "bicycle" ? "1,5" : String(LANE_WIDTH).replace(".", ",")} {" "}{tr("м)")}</option>
            {WIDTHS.map((v) => <option key={v} value={v}>{v.replace(".", ",")} {" "}{tr("м")}</option>)}
            {lane.width && !WIDTHS.includes(lane.width) && <option value={lane.width}>{lane.width} {" "}{tr("м")}</option>}
          </select>
        </div>
      )}
    </div>
  );
}
