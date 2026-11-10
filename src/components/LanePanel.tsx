// Панель полос выбранной дороги: схема поперек дороги и свойства выбранной полосы
import { setWayTags } from "../model/store";
import { addLane, canCross, getLanes, lanesToTags, setCross, setDir, useLane, TURNS, LANE_WIDTH, type Lane, type LaneKind, type Lanes } from "../model/lanes";
import { maxSpeed } from "../model/roads";
import { DirIcon, TurnIcon } from "./turnIcons";
import type { OsmWay } from "../osm/types";

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
    edit({ turn: next.join(";") }, "Поворот с полосы");
  };

  return (
    <div className="lanes-box">
      <h3>Полосы по отдельности</h3>
      <div className="lanes-strip" title="Схема поперек дороги, если смотреть по направлению линии">
        {lanes.map((l, i) => (
          <button key={i} className={`lane-btn k-${l.kind}${i === index ? " on" : ""}`} onClick={() => setSel(i === index ? null : { wayId: way.id, index: i })} title={(l.dir === "forward" ? "Туда" : "Обратно") + (l.turn ? ", " + l.turn : "")}>
            <b><DirIcon back={l.dir !== "forward"} /></b>
            <small>{l.turn ? <TurnIcon turn={l.turn} size={14} /> : "·"}</small>
          </button>
        ))}
      </div>
      <div className="chips">
        <button onClick={() => { const r = addLane(lanes, "backward"); save(r.lanes, "Полоса добавлена", r.index); }} title="Добавить полосу против направления линии (слева)">+ Обратно</button>
        <button onClick={() => { const r = addLane(lanes, "forward"); save(r.lanes, "Полоса добавлена", r.index); }} title="Добавить полосу по направлению линии (справа)">+ Туда</button>
        <button className="danger" disabled={index === null || lanes.length < 2} onClick={() => save(lanes.filter((_, i) => i !== index), "Полоса удалена", null)}>Удалить полосу</button>
      </div>

      {!lane && <p className="hint">Выберите полосу на схеме или кликните по ней на карте (полосы видны с масштаба 100 м).</p>}
      {lane && (
        <div className="form">
          <span>Направление</span>
          <div className="seg">
            {(["forward", "backward"] as const).map((d) => (
              <button key={d} className={lane.dir === d ? "on" : ""} onClick={() => { if (lane.dir === d) return; const r = setDir(lanes, index!, d); save(r.lanes, "Направление полосы", r.index); }}><DirIcon back={d !== "forward"} />{d === "forward" ? "Туда" : "Обратно"}</button>
            ))}
          </div>
          <span>Поворот</span>
          <div className="seg">
            {TURNS.map(([t, name]) => (
              <button key={t} title={name} className={lane.turn.split(";").includes(t) ? "on" : ""} onClick={() => toggleTurn(t)}><TurnIcon turn={t} /></button>
            ))}
          </div>
          {(["left", "right"] as const).map((side) => {
            const nb = neighbor(side);
            const allow = canCross(lane, crossOf(side));
            return [
              <span key={side + "l"}>{side === "left" ? "Линия слева" : "Линия справа"}</span>,
              nb ? (
                <div key={side} className="seg">
                  <button className={allow === true ? "on" : ""} title="Перестраиваться можно" onClick={() => save(setCross(lanes, index!, crossOf(side), true), "Разметка: прерывистая")}>Прерывистая</button>
                  <button className={allow === false ? "on" : ""} title="Перестраиваться нельзя" onClick={() => save(setCross(lanes, index!, crossOf(side), false), "Разметка: сплошная")}>Сплошная</button>
                </div>
              ) : <span key={side} className="muted">край дороги</span>,
            ];
          })}
          <span>Тип</span>
          <div className="seg">
            {KINDS.map(([k, name]) => <button key={k} className={lane.kind === k ? "on" : ""} onClick={() => edit({ kind: k }, "Тип полосы: " + name)}>{name}</button>)}
          </div>
          <span>Скорость</span>
          <select value={lane.speed} onChange={(e) => edit({ speed: e.target.value }, "Скорость полосы")}>
            <option value="">как у дороги ({maxSpeed(way)})</option>
            {SPEEDS.map((v) => <option key={v} value={v}>{v} км/ч</option>)}
            {lane.speed && !SPEEDS.includes(lane.speed) && <option value={lane.speed}>{lane.speed}</option>}
          </select>
          <span>Ширина</span>
          <select value={lane.width} onChange={(e) => edit({ width: e.target.value }, "Ширина полосы")}>
            <option value="">по умолчанию ({lane.kind === "bicycle" ? "1,5" : String(LANE_WIDTH).replace(".", ",")} м)</option>
            {WIDTHS.map((v) => <option key={v} value={v}>{v.replace(".", ",")} м</option>)}
            {lane.width && !WIDTHS.includes(lane.width) && <option value={lane.width}>{lane.width} м</option>}
          </select>
        </div>
      )}
    </div>
  );
}
