// Выбор шаблона новой дороги карточками: у каждой рисунок поперечного профиля,
// число полос, ширина проезжей части и скорость. Так шаблон узнается с одного взгляда.
import { useEffect, useRef, useState } from "react";
import { TEMPLATES } from "../model/templates";
import { getLanes, laneWidth } from "../model/lanes";
import type { OsmWay, Tags } from "../osm/types";
import { locale, tr } from "../i18n";
import Icon from "./Icon";

type Tpl = { name: string; tags: Tags; kind?: "track" | "area" | "path" };

// Полосы шаблона: считаем их так же, как у настоящей дороги с этими тегами
const lanesOf = (tags: Tags) => getLanes({ id: 0, nodeIds: [], tags, attrs: {} } as OsmWay);

// Рисунок профиля: вид сверху на кусок дороги, полосы в масштабе 1 м = 5 пикселей
function Profile({ t }: { t: Tpl }) {
  const W = 96, H = 28;
  if (t.kind === "area") return <svg width={W} height={H}><rect x={34} y={4} width={28} height={20} rx={2} className="tp-bld" /></svg>;
  if (t.kind === "track") return <svg width={W} height={H}>{[42, 54].map((x) => <line key={x} x1={x} x2={x} y1={0} y2={H} className="tp-rail" />)}{[5, 14, 23].map((y) => <line key={y} x1={38} x2={58} y1={y} y2={y} className="tp-tie" />)}</svg>;
  if (t.kind === "path") return <svg width={W} height={H}><rect x={42} y={0} width={12} height={H} className="tp-path" /></svg>;
  const lanes = lanesOf(t.tags), k = 5;
  const total = lanes.reduce((s, l) => s + laneWidth(l), 0) * k;
  let x = (W - total) / 2;
  const parts = lanes.map((l, i) => {
    const w = laneWidth(l) * k, x0 = x, up = l.dir === "forward", cx = x0 + w / 2;
    x += w;
    const next = lanes[i + 1];
    return (
      <g key={i}>
        <rect x={x0} y={0} width={w} height={H} className="tp-lane" />
        {/* стрелка направления движения по полосе */}
        <path d={up ? `M${cx} 7 l4 7 h-8 z M${cx} 14 v8` : `M${cx} 21 l4 -7 h-8 z M${cx} 14 v-8`} className="tp-arrow" />
        {/* линия между полосами: желтая между встречными, белая прерывистая между попутными */}
        {next && <line x1={x} x2={x} y1={0} y2={H} className={next.dir !== l.dir ? "tp-mid" : "tp-dash"} />}
      </g>
    );
  });
  return <svg width={W} height={H}>{parts}<line x1={(W - total) / 2} x2={(W - total) / 2} y1={0} y2={H} className="tp-edge" /><line x1={x} x2={x} y1={0} y2={H} className="tp-edge" /></svg>;
}

// Подпись под названием: полосы, ширина проезжей части, скорость
function caption(t: Tpl): string {
  if (t.kind === "area") return tr("контур по углам");
  if (t.kind === "track") return tr("рельсовые пути");
  if (t.kind === "path") return tr("для пешеходов");
  const lanes = lanesOf(t.tags);
  const width = lanes.reduce((s, l) => s + laneWidth(l), 0).toLocaleString(locale(), { maximumFractionDigits: 1 });
  return tr("{0} пол. · ПЧ {1} м", lanes.length, width) + (t.tags.maxspeed ? " · " + tr("{0} км/ч", t.tags.maxspeed) : "");
}

export default function TemplatePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // клик мимо списка или Esc закрывает его
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); };
  }, [open]);
  const cur: Tpl = TEMPLATES[value] ?? TEMPLATES.secondary;
  const groups: [string, string[]][] = [
    [tr("Дороги"), Object.keys(TEMPLATES).filter((k) => !TEMPLATES[k].kind)],
    [tr("Пути, тротуары, здания"), Object.keys(TEMPLATES).filter((k) => TEMPLATES[k].kind)],
  ];
  return (
    <div className="tp" ref={box}>
      <button className={"tp-cur" + (open ? " on" : "")} onClick={() => setOpen(!open)} title={tr("Шаблон новой дороги: тип, полосы и скорость")}>
        <Profile t={cur} /><span>{cur.name}</span><Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="tp-list">
          {groups.map(([title, keys]) => (
            <div key={title}>
              <div className="tp-title">{title}</div>
              <div className="tp-grid">
                {keys.map((k) => (
                  <button key={k} className={"tp-card" + (k === value ? " on" : "")} onClick={() => { onChange(k); setOpen(false); }}>
                    <Profile t={TEMPLATES[k]} />
                    <b>{TEMPLATES[k].name}</b>
                    <small>{caption(TEMPLATES[k])}</small>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
