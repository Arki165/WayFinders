import { useEffect, useRef, useState } from "react";
import { Chart, registerables } from "chart.js";
import { useEditor, setWayTags } from "../model/store";
import { calcWay, MEASURE_KEYS, zLevel, Z_COLORS, Z_TEXT, type CalcResult, type Norms } from "../model/calc";
import { SURFACES, ROAD_CLASSES, wayName, isDrivable } from "../model/roads";
import { saveCsv, savePng, toCsv } from "../model/exporting";
import Icon from "./Icon";

Chart.register(...registerables);

const fmt = (x: number | null, n = 0) => (x === null || !isFinite(x) ? "-" : x.toLocaleString("ru-RU", { minimumFractionDigits: n, maximumFractionDigits: n }));
type ChartKind = "z" | "time" | "speed";

export default function CalcPanel() {
  const data = useEditor((s) => s.data);
  const version = useEditor((s) => s.version);
  const norms = useEditor((s) => s.norms);
  const analysis = useEditor((s) => s.analysis);
  const setAnalysis = useEditor((s) => s.setAnalysis);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const fileName = useEditor((s) => s.fileName);
  const [kind, setKind] = useState<ChartKind>("z");
  const [showNorms, setShowNorms] = useState(false);
  // график рисуется в цветах темы: следим за переключением светлой и темной
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<Chart | null>(null);

  const ids = analysis.filter((id) => data?.ways.has(id));
  const rows: { id: number; name: string; c: CalcResult }[] = data ? ids.map((id) => { const w = data.ways.get(id)!; return { id, name: wayName(w), c: calcWay(data, w, norms) }; }) : [];

  // график перерисовывается после любой правки
  useEffect(() => {
    if (!canvas.current) return;
    chart.current?.destroy();
    if (!rows.length) { chart.current = null; return; }
    const labels = rows.map((r) => (r.name.length > 22 ? r.name.slice(0, 21) + "…" : r.name) + ` #${String(r.id).slice(-3)}`);
    const rgb = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    const datasets =
      kind === "z"
        ? [{ label: "Коэффициент загрузки Z", data: rows.map((r) => r.c.Z ?? 0), backgroundColor: rows.map((r) => (r.c.Z === null ? "rgba(160,160,160,.5)" : rgb(Z_COLORS[zLevel(r.c.Z, norms)]))) }]
        : kind === "time"
          ? [
              { label: "T своб, мин", data: rows.map((r) => +r.c.Tfree.toFixed(2)), backgroundColor: "rgba(63,157,90,.85)" },
              { label: "T факт, мин", data: rows.map((r) => r.c.Tfact ?? 0), backgroundColor: "rgba(216,64,47,.85)" },
            ]
          : [
              { label: "V своб, км/ч", data: rows.map((r) => +r.c.Vfree.toFixed(1)), backgroundColor: "rgba(31,111,209,.85)" },
              { label: "V ср, км/ч", data: rows.map((r) => (r.c.Vavg === null ? 0 : +r.c.Vavg.toFixed(1))), backgroundColor: "rgba(229,154,40,.85)" },
            ];
    // цвета берутся из CSS-переменных темы (index.css)
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue("--fg").trim(), muted = css.getPropertyValue("--muted").trim();
    const grid = css.getPropertyValue("--line").trim(), bg = css.getPropertyValue("--panel").trim();
    chart.current = new Chart(canvas.current, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { position: "bottom", labels: { color: fg, boxWidth: 12 } },
          title: { display: true, color: fg, font: { weight: 600 }, text: kind === "z" ? `Загрузка участков (пороги: ${norms.z1} / ${norms.z2} / ${norms.z3})` : kind === "time" ? "Время проезда: свободное и фактическое" : "Скорость: свободная и средняя" },
        },
        scales: { x: { ticks: { color: muted }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: muted }, grid: { color: grid } } },
      },
      plugins: [{ id: "bg", beforeDraw: (c) => { const ctx = c.ctx; ctx.save(); ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); ctx.restore(); } }],
    });
  }, [kind, version, norms, analysis.join(), theme]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => chart.current?.destroy(), []);

  if (!data) return <p className="hint pad">Откройте файл .osm</p>;

  const selWay = selection?.kind === "way" ? data.ways.get(selection.id) : undefined;
  const addMajor = () => {
    const list = [...data.ways.values()].filter((w) => isDrivable(w) && ["primary", "secondary", "tertiary", "trunk"].includes(w.tags.highway)).map((w) => w.id);
    setAnalysis([...new Set([...analysis, ...list])]);
  };
  const setMeasure = (id: number, key: string, v: string) => {
    const w = data.ways.get(id)!;
    const tags = { ...w.tags };
    if (v.trim() === "") delete tags[key]; else tags[key] = String(Number(v.replace(",", ".")));
    setWayTags(id, tags, key === MEASURE_KEYS.volume ? "Замер N" : "Замер T факт");
  };
  const exportCsv = () => {
    const header = ["way id", "Дорога", "L, км", "V max, км/ч", "k покрытия", "V своб, км/ч", "T своб, мин", "Полос", "P, авт/ч", "N, авт/ч", "T факт, мин", "Z", "Загрузка", "V ср, км/ч", "q, авт/км", "T зад, мин", "D, %"];
    const r = (x: number | null, n: number) => (x === null || !isFinite(x) ? null : +x.toFixed(n));
    saveCsv(fileName.replace(/\.osm$/i, "") + "_calc.csv", toCsv(header, rows.map(({ id, name, c }) => [id, name, r(c.L, 3), c.Vmax, c.kSurface, r(c.Vfree, 1), r(c.Tfree, 2), c.lanes, c.P, c.N, c.Tfact, r(c.Z, 2), c.Z === null ? "" : Z_TEXT[zLevel(c.Z, norms)], r(c.Vavg, 1), r(c.q, 1), r(c.Tdelay, 2), r(c.D, 0)])));
  };

  return (
    <div className="calc">
      <div className="calc-left">
        <div className="chips">
          {selWay && isDrivable(selWay) && !analysis.includes(selWay.id) && <button className="on" onClick={() => setAnalysis([...analysis, selWay.id])}><Icon name="plus" size={14} />Выделенная: {wayName(selWay)}</button>}
          <button onClick={addMajor}><Icon name="plus" size={14} />Все крупные улицы</button>
          {rows.length > 0 && <button onClick={() => setAnalysis([])}>Очистить</button>}
          <button onClick={exportCsv} disabled={!rows.length}><Icon name="download" size={14} />CSV</button>
          <button className={showNorms ? "on" : ""} onClick={() => setShowNorms(!showNorms)}>Нормативы</button>
        </div>
        {showNorms ? <NormsEditor /> : (
          <div className="tbl-wrap">
            <table className="tbl calc-tbl">
              <thead>
                <tr><th>Участок</th><th className="r">L, км</th><th className="r">V своб</th><th className="r">T своб, мин</th><th className="r">P</th><th className="r">N, авт/ч</th><th className="r">T факт, мин</th><th className="r">Z</th><th className="r">V ср</th><th className="r">q</th><th className="r">T зад</th><th className="r">D, %</th><th /></tr>
              </thead>
              <tbody>
                {rows.map(({ id, name, c }) => (
                  <tr key={id} className={selection?.kind === "way" && selection.id === id ? "sel" : ""}>
                    <td className="click" onClick={() => select({ kind: "way", id })}>{name}</td>
                    <td className="r">{fmt(c.L, 3)}</td>
                    <td className="r" title={`${c.Vmax} × ${c.kSurface}`}>{fmt(c.Vfree, 1)}</td>
                    <td className="r"><b>{fmt(c.Tfree, 2)}</b></td>
                    <td className="r">{fmt(c.P)}</td>
                    <td className="r"><input defaultValue={c.N ?? ""} key={"n" + id + c.N} placeholder="Замер" onBlur={(e) => e.target.value !== String(c.N ?? "") && setMeasure(id, MEASURE_KEYS.volume, e.target.value)} /></td>
                    <td className="r"><input defaultValue={c.Tfact ?? ""} key={"t" + id + c.Tfact} placeholder="Замер" onBlur={(e) => e.target.value !== String(c.Tfact ?? "") && setMeasure(id, MEASURE_KEYS.time, e.target.value)} /></td>
                    <td className="r">{c.Z === null ? "-" : <span className="zpill" style={{ background: `rgb(${Z_COLORS[zLevel(c.Z, norms)].join(",")})` }}>{fmt(c.Z, 2)}</span>}</td>
                    <td className="r">{fmt(c.Vavg, 1)}</td>
                    <td className="r">{fmt(c.q, 0)}</td>
                    <td className="r">{fmt(c.Tdelay, 2)}</td>
                    <td className="r">{fmt(c.D, 0)}</td>
                    <td><button className="x" title="Убрать" onClick={() => setAnalysis(analysis.filter((x) => x !== id))}><Icon name="close" size={14} /></button></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={13} className="muted">Добавьте участки: выделите дорогу и нажмите «+ Выделенная» или добавьте все крупные улицы.</td></tr>}
              </tbody>
            </table>
            <p className="hint">Как считается каждая величина, смотрите на вкладке «Формулы». Замеры N и T факт сохраняются в .osm.</p>
          </div>
        )}
      </div>
      <div className="calc-right">
        <div className="chips">
          <div className="seg">
            {([["z", "Загрузка Z"], ["time", "Время"], ["speed", "Скорость"]] as const).map(([k, l]) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{l}</button>)}
          </div>
          <button disabled={!rows.length} onClick={() => canvas.current && savePng(fileName.replace(/\.osm$/i, "") + `_${kind}.png`, canvas.current)}><Icon name="download" size={14} />PNG</button>
        </div>
        <div className="chart-box"><canvas ref={canvas} />{!rows.length && <p className="hint center">Здесь будет график по участкам из таблицы</p>}</div>
      </div>
    </div>
  );
}

function NormsEditor() {
  const norms = useEditor((s) => s.norms);
  const setNorms = useEditor((s) => s.setNorms);
  const upd = (patch: Partial<Norms>) => setNorms({ ...norms, ...patch });
  const num = (v: string, min = 0) => Math.max(min, Number(v.replace(",", ".")) || 0);
  return (
    <div className="norms">
      <table className="tbl">
        <thead><tr><th>Класс дороги</th><th className="r">Полоса, авт/ч</th></tr></thead>
        <tbody>
          {Object.entries(norms.laneCapacity).map(([k, v]) => (
            <tr key={k}><td>{k === "link" ? "Съезды" : ROAD_CLASSES[k]?.ru ?? k}</td><td className="r"><input type="number" defaultValue={v} onBlur={(e) => upd({ laneCapacity: { ...norms.laneCapacity, [k]: num(e.target.value, 1) } })} /></td></tr>
          ))}
        </tbody>
      </table>
      <table className="tbl">
        <thead><tr><th>Покрытие</th><th className="r">Коэффициент скорости</th></tr></thead>
        <tbody>
          {Object.entries(norms.surfaceK).map(([k, v]) => (
            <tr key={k}><td>{SURFACES[k]?.ru ?? k}</td><td className="r"><input type="number" step="0.05" defaultValue={v} onBlur={(e) => upd({ surfaceK: { ...norms.surfaceK, [k]: Math.min(1, num(e.target.value)) } })} /></td></tr>
          ))}
        </tbody>
      </table>
      <table className="tbl">
        <thead><tr><th>Порог Z</th><th className="r">От</th></tr></thead>
        <tbody>
          {(["z1", "z2", "z3"] as const).map((k, i) => (
            <tr key={k}><td><span className="zpill" style={{ background: `rgb(${Z_COLORS[i + 1].join(",")})` }}>{Z_TEXT[i + 1]}</span></td><td className="r"><input type="number" step="0.05" defaultValue={norms[k]} onBlur={(e) => upd({ [k]: num(e.target.value) })} /></td></tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Значения условные. Пропускную способность, коэффициенты покрытия и пороги задают транспортники по нормативам.</p>
    </div>
  );
}
