// Сводка по открытому графу: показывается внизу панели «Свойства», когда ничего не выделено.
// Сколько километров дорог каждого класса, сколько перекрестков, светофоров и остановок,
// и самые загруженные участки по замерам (клик ведет к участку на карте).
import { useMemo } from "react";
import { useEditor } from "../model/store";
import { ROAD_CLASSES, drivableNodeSet, isDrivable, isRoadSignal, wayName } from "../model/roads";
import { wayLengthM } from "../model/geo";
import { calcWay, MEASURE_KEYS, zLevel, Z_COLORS, Z_TEXT } from "../model/calc";
import { poiKind } from "../model/poi";

// Классы дорог собраны в понятные группы, цвет берется у главного класса группы
const GROUPS: { ru: string; classes: string[] }[] = [
  { ru: "Магистрали", classes: ["motorway", "trunk", "primary"] },
  { ru: "Районные", classes: ["secondary"] },
  { ru: "Местные", classes: ["tertiary", "unclassified"] },
  { ru: "Жилые и проезды", classes: ["residential", "living_street", "service"] },
  { ru: "Съезды", classes: ["motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"] },
];

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const km = (m: number) => (m / 1000).toLocaleString("ru-RU", { maximumFractionDigits: m < 10000 ? 1 : 0 });

export default function GraphSummary() {
  const data = useEditor((s) => s.data);
  const version = useEditor((s) => s.version);
  const norms = useEditor((s) => s.norms);

  // считаем один раз на каждую правку, а не на каждую перерисовку
  const sum = useMemo(() => {
    if (!data) return null;
    const byGroup = GROUPS.map(() => 0);
    let roads = 0, total = 0;
    const measured: { id: number; name: string; z: number }[] = [];
    const useCount = new Map<number, number>(); // сколько дорог проходит через узел
    for (const w of data.ways.values()) {
      if (!isDrivable(w)) continue;
      roads++;
      const len = wayLengthM(data, w);
      total += len;
      const g = GROUPS.findIndex((gr) => gr.classes.includes(w.tags.highway));
      if (g >= 0) byGroup[g] += len;
      for (const id of new Set(w.nodeIds)) useCount.set(id, (useCount.get(id) ?? 0) + 1);
      // загрузка Z есть только у дорог с замером N, остальные не считаем
      if (w.tags[MEASURE_KEYS.volume]) {
        const c = calcWay(data, w, norms);
        if (c.Z !== null) measured.push({ id: w.id, name: wayName(w), z: c.Z });
      }
    }
    // перекресток - узел, где сходятся две и больше дорог
    let crossroads = 0;
    for (const n of useCount.values()) if (n >= 2) crossroads++;
    const onRoad = drivableNodeSet(data);
    let signals = 0, stops = 0;
    for (const n of data.nodes.values()) {
      if (isRoadSignal(n, onRoad)) signals++;
      const k = poiKind(n);
      if (k === "bus" || k === "tram") stops++;
    }
    measured.sort((a, b) => b.z - a.z);
    return { roads, total, byGroup, crossroads, signals, stops, top: measured.slice(0, 3), measured: measured.length };
  }, [data, version, norms]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sum) return null;
  const max = Math.max(...sum.byGroup, 1);

  // клик по участку: выделить его и показать на карте
  const goTo = (id: number) => {
    const s = useEditor.getState();
    const w = s.data?.ways.get(id);
    if (!w) return;
    const n = s.data!.nodes.get(w.nodeIds[Math.floor(w.nodeIds.length / 2)]);
    s.select({ kind: "way", id });
    if (n) s.flyTo(n.lat, n.lon, 17);
  };

  return (
    <div className="summary">
      <h3>Сводка по графу</h3>
      <div className="sum-stats">
        <div><b>{km(sum.total)}</b><span>км дорог</span></div>
        <div><b>{sum.crossroads.toLocaleString("ru-RU")}</b><span>перекрестков</span></div>
        <div><b>{sum.signals.toLocaleString("ru-RU")}</b><span>светофоров</span></div>
        <div><b>{sum.stops.toLocaleString("ru-RU")}</b><span>остановок</span></div>
      </div>
      <div className="sum-bars">
        {GROUPS.map((g, i) => sum.byGroup[i] > 0 && (
          <div key={g.ru} className="sum-bar" title={`${g.ru}: ${km(sum.byGroup[i])} км`}>
            <i style={{ background: `rgb(${ROAD_CLASSES[g.classes[0]].color.join(",")})` }} />
            <span>{g.ru}</span>
            <div className="sum-track"><div style={{ width: `${(sum.byGroup[i] / max) * 100}%` }} /></div>
            <b>{km(sum.byGroup[i])}</b>
          </div>
        ))}
      </div>
      <h3>Самые загруженные</h3>
      {sum.top.length ? (
        <div className="sum-top">
          {sum.top.map((t) => (
            <button key={t.id} onClick={() => goTo(t.id)} title="Показать на карте">
              <span className="zpill" style={{ background: `rgb(${Z_COLORS[zLevel(t.z, norms)].join(",")})` }}>{t.z.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}</span>
              <span className="sum-name">{t.name}</span>
              <small>{cap(Z_TEXT[zLevel(t.z, norms)])}</small>
            </button>
          ))}
          {sum.measured > 3 && <p className="hint">Всего участков с замерами: {sum.measured}</p>}
        </div>
      ) : (
        <p className="hint">Замеров пока нет. Введите N в таблице «Расчеты и графики», и здесь появятся участки с самой высокой загрузкой.</p>
      )}
    </div>
  );
}
