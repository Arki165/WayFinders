import { useEffect, useRef, useState, type ReactNode } from "react";
import { Chart, registerables } from "chart.js";
import { useEditor, setWayTags } from "../model/store";
import { calcWay, DEFAULT_NORMS, MEASURE_KEYS, zLevel, Z_COLORS, Z_TEXT, type CalcResult, type Norms } from "../model/calc";
import { SURFACES, ROAD_CLASSES, wayName, isDrivable } from "../model/roads";
import { saveCsv, savePdf, savePng, saveXlsx, toCsv } from "../model/exporting";
import type { Cell } from "../model/xlsx";
import { flowCurve, flowPoint, FLOW_AXES, FLOW_SHORT, FLOW_TITLES, type FlowKind } from "../model/flow";
import Icon from "./Icon";

Chart.register(...registerables);

// строка таблицы и сортировка по столбцу
type Row = { id: number; name: string; c: CalcResult };
type SortKey = "name" | "L" | "Vfree" | "Tfree" | "P" | "N" | "Tfact" | "Z" | "Vavg" | "q" | "Tdelay" | "D";
function compareRows(a: Row, b: Row, key: SortKey, dir: 1 | -1): number {
  if (key === "name") return a.name.localeCompare(b.name, "ru") * dir;
  const x = a.c[key], y = b.c[key];
  // пустые значения (нет замера) всегда внизу списка
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  return (x - y) * dir;
}

const fmt = (x: number | null, n = 0) => (x === null || !isFinite(x) ? "-" : x.toLocaleString("ru-RU", { minimumFractionDigits: n, maximumFractionDigits: n }));
// столбцы по участкам или диаграмма потока (модель + замеры)
type ChartKind = "z" | "time" | "speed" | FlowKind;
const FLOW_KINDS: FlowKind[] = ["Nq", "Vq", "DZ", "VN", "Dq", "Tt"];
const isFlow = (k: ChartKind): k is FlowKind => (FLOW_KINDS as string[]).includes(k);

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
  // сортировка таблицы: столбец и направление (1 - по возрастанию, -1 - по убыванию)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
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
  const rows: Row[] = data ? ids.map((id) => { const w = data.ways.get(id)!; return { id, name: wayName(w), c: calcWay(data, w, norms) }; }) : [];
  if (sort) rows.sort((a, b) => compareRows(a, b, sort.key, sort.dir));
  // клик по заголовку: по возрастанию, потом по убыванию, потом как добавляли
  const clickSort = (key: SortKey) => setSort(!sort || sort.key !== key ? { key, dir: 1 } : sort.dir === 1 ? { key, dir: -1 } : null);
  const Th = ({ k, children, title }: { k: SortKey; children: ReactNode; title?: string }) => (
    <th className={"sortable" + (k === "name" ? "" : " r") + (sort?.key === k ? " sorted" : "")} title={title ?? "Сортировать"} onClick={() => clickSort(k)}>
      {children}
      {sort?.key === k && <Icon name={sort.dir === 1 ? "chevronUp" : "chevronDown"} size={12} />}
    </th>
  );

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
    const bgPlugin = { id: "bg", beforeDraw: (c: Chart) => { const ctx = c.ctx; ctx.save(); ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); ctx.restore(); } };
    if (isFlow(kind)) {
      // диаграмма потока: модельная кривая выбранного участка (или первого в таблице) и точки участков с замерами
      const ref = rows.find((r) => selection?.kind === "way" && r.id === selection.id) ?? rows[0];
      const pts = rows.map((r) => ({ r, p: flowPoint(kind, r.c) })).filter((x) => x.p);
      const [ax, ay] = FLOW_AXES[kind];
      chart.current = new Chart(canvas.current, {
        type: "scatter",
        data: {
          datasets: [
            { label: `Модель: ${ref.name}`, data: flowCurve(kind, ref.c), showLine: true, pointRadius: kind === "Tt" ? 3 : 0, borderColor: "rgba(31,111,209,.9)", backgroundColor: "rgba(31,111,209,.9)", borderWidth: 2, tension: 0.3 },
            ...(pts.length ? [{ label: "Участки по замерам", data: pts.map((x) => ({ ...x.p!, name: x.r.name })), pointRadius: 5, backgroundColor: "rgba(216,64,47,.85)", borderColor: "rgba(216,64,47,1)" }] : []),
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { position: "bottom", labels: { color: fg, boxWidth: 12 } },
            title: { display: true, color: fg, font: { weight: 600 }, text: FLOW_TITLES[kind] + (kind !== "Tt" && !pts.length ? " (замеров нет, только модель)" : "") },
            tooltip: { callbacks: { label: (it) => { const p = it.raw as { x: number; y: number; name?: string }; return `${p.name ? p.name + ": " : ""}${ax.split(",")[0]} ${fmt(p.x, 1)}, ${ay.split(",")[0]} ${fmt(p.y, 1)}`; } } },
          },
          scales: {
            x: { type: "linear", min: kind === "Tt" ? 0 : undefined, max: kind === "Tt" ? 23 : undefined, title: { display: true, text: ax, color: muted }, ticks: { color: muted, stepSize: kind === "Tt" ? 2 : undefined }, grid: { color: grid } },
            y: { beginAtZero: true, title: { display: true, text: ay, color: muted }, ticks: { color: muted, callback: (v) => fmt(Number(v), Math.abs(Number(v)) < 10 && Number(v) % 1 ? 1 : 0) }, grid: { color: grid } },
          },
        },
        plugins: [bgPlugin],
      });
      return;
    }
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
      plugins: [bgPlugin],
    });
  }, [kind, version, norms, analysis.join(), theme, sort?.key, sort?.dir, selection]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => chart.current?.destroy(), []);

  if (!data) return <p className="hint pad">Откройте файл .osm</p>;

  const selWay = selection?.kind === "way" ? data.ways.get(selection.id) : undefined;
  // несколько выделенных дорог (Shift+клик или участок между узлами): проезжие, которых еще нет в таблице
  const selMany = selection?.kind === "ways" ? selection.ids.filter((id) => { const w = data.ways.get(id); return w && isDrivable(w) && !analysis.includes(id); }) : [];
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
  // Таблица расчета для выгрузки: заголовок и строки (одна и та же для CSV, Excel и PDF)
  const TABLE_HEAD = ["way id", "Дорога", "L, км", "V max, км/ч", "k покрытия", "V своб, км/ч", "T своб, мин", "Полос", "P, авт/ч", "N, авт/ч", "T факт, мин", "Z", "Загрузка", "V ср, км/ч", "q, авт/км", "T зад, мин", "D, %"];
  const tableRows = (): Cell[][] => {
    const r = (x: number | null, n: number) => (x === null || !isFinite(x) ? null : +x.toFixed(n));
    return rows.map(({ id, name, c }) => [id, name, r(c.L, 3), c.Vmax, c.kSurface, r(c.Vfree, 1), r(c.Tfree, 2), c.lanes, c.P, c.N, c.Tfact, r(c.Z, 2), c.Z === null ? "" : Z_TEXT[zLevel(c.Z, norms)], r(c.Vavg, 1), r(c.q, 1), r(c.Tdelay, 2), r(c.D, 0)]);
  };
  const base = () => fileName.replace(/\.osm$/i, "");
  const exportCsv = () => saveCsv(base() + "_calc.csv", toCsv(TABLE_HEAD, tableRows()));
  const exportXlsx = () => saveXlsx(base() + "_calc.xlsx", [{ name: "Расчет", rows: [TABLE_HEAD, ...tableRows()] }, ...(chart.current ? [{ name: "График", rows: chartRows() }] : [])]);

  // Числа текущего графика: у столбиков - участок и значения рядов, у диаграмм - точки x, y каждого ряда
  const chartTitle = () => String((chart.current?.options.plugins?.title as { text?: string } | undefined)?.text ?? "График");
  const chartRows = (): Cell[][] => {
    const ch = chart.current;
    if (!ch) return [];
    const r = (x: unknown) => (typeof x === "number" && isFinite(x) ? +x.toFixed(3) : null);
    const sets = ch.data.datasets;
    if (ch.data.labels?.length) {
      return [["Участок", ...sets.map((d) => d.label ?? "")], ...ch.data.labels.map((l, i) => [String(l), ...sets.map((d) => r(d.data[i]))])];
    }
    const [ax, ay] = isFlow(kind) ? FLOW_AXES[kind] : ["x", "y"];
    const out: Cell[][] = [["Ряд", ax, ay]];
    for (const d of sets) for (const p of d.data as { x: number; y: number }[]) out.push([d.label ?? "", r(p.x), r(p.y)]);
    return out;
  };
  const exportChartXlsx = () => saveXlsx(base() + `_${kind}.xlsx`, [{ name: "График", rows: chartRows() }, { name: "Расчет", rows: [TABLE_HEAD, ...tableRows()] }]);

  // PDF: заголовок, картинка графика и таблица расчета на листе A4 альбомом
  const exportPdf = () => {
    const cv = canvas.current;
    if (!cv) return;
    // фон под графиком цвета панели: в темной теме подписи светлые и на белом не видны
    const bg = document.createElement("canvas");
    bg.width = cv.width; bg.height = cv.height;
    const g = bg.getContext("2d")!;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim() || "#fff";
    g.fillRect(0, 0, bg.width, bg.height);
    g.drawImage(cv, 0, 0);
    const esc = (x: Cell) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const num = (x: Cell) => (typeof x === "number" ? x.toLocaleString("ru-RU") : esc(x));
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(chartTitle())}</title><style>
      body { font: 11px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1d2125; margin: 0; }
      h1 { font-size: 17px; margin: 0 0 2px; } .sub { color: #6b7178; margin-bottom: 12px; }
      img { display: block; max-width: 100%; max-height: 90mm; margin: 0 auto 14px; border-radius: 6px; }
      table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #d5d8dc; padding: 3px 5px; text-align: right; }
      th { background: #eef0f2; font-weight: 600; } td:nth-child(2), th:nth-child(2) { text-align: left; } tr { page-break-inside: avoid; }
    </style></head><body>
      <h1>${esc(chartTitle())}</h1>
      <div class="sub">Wayfinder · ${esc(fileName)} · ${new Date().toLocaleString("ru-RU")} · участков: ${rows.length}</div>
      <img src="${bg.toDataURL("image/png")}">
      <table><thead><tr>${TABLE_HEAD.slice(1).map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${tableRows().map((r) => `<tr>${r.slice(1).map((x) => `<td>${num(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>
    </body></html>`;
    savePdf(base() + `_${kind}.pdf`, html);
  };
  const [saveMenu, setSaveMenu] = useState(false);

  return (
    <div className="calc">
      <div className="calc-left">
        <div className="chips">
          {selWay && isDrivable(selWay) && !analysis.includes(selWay.id) && <button className="on" onClick={() => setAnalysis([...analysis, selWay.id])}><Icon name="plus" size={14} />Выделенная: {wayName(selWay)}</button>}
          {selMany.length > 0 && <button className="on" onClick={() => setAnalysis([...analysis, ...selMany])}><Icon name="plus" size={14} />Выделенные: {selMany.length}</button>}
          <button onClick={addMajor}><Icon name="plus" size={14} />Все крупные улицы</button>
          {rows.length > 0 && <button onClick={() => setAnalysis([])}>Очистить</button>}
          <button onClick={exportCsv} disabled={!rows.length} title="Таблица для Excel и других программ"><Icon name="download" size={14} />CSV</button>
          <button onClick={exportXlsx} disabled={!rows.length} title="Таблица Excel: лист «Расчет» и лист «График» с числами графика"><Icon name="download" size={14} />Excel</button>
          <button className={showNorms ? "on" : ""} onClick={() => setShowNorms(!showNorms)}>Нормативы</button>
        </div>
        {showNorms ? <NormsEditor /> : (
          <div className="tbl-wrap">
            <table className="tbl calc-tbl">
              <thead>
                <tr>
                  <Th k="name">Участок</Th><Th k="L">L, км</Th><Th k="Vfree">V своб</Th><Th k="Tfree">T своб, мин</Th><Th k="P">P</Th><Th k="N">N, авт/ч</Th>
                  <Th k="Tfact">T факт, мин</Th><Th k="Z">Z</Th><Th k="Vavg">V ср</Th><Th k="q">q</Th><Th k="Tdelay">T зад</Th><Th k="D">D, %</Th><th />
                </tr>
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
          {/* диаграммы потока: модельная кривая выбранного участка и точки замеров */}
          <select className={isFlow(kind) ? "on" : ""} value={isFlow(kind) ? kind : ""} onChange={(e) => e.target.value && setKind(e.target.value as FlowKind)} title="Диаграммы транспортного потока: модель для выбранного участка (или первого в таблице) и участки с замерами">
            <option value="">Диаграммы потока...</option>
            {FLOW_KINDS.map((k) => <option key={k} value={k}>{FLOW_SHORT[k]}: {FLOW_TITLES[k].split(": ").pop()}</option>)}
          </select>
          {/* сохранить график: картинка, PDF с таблицей или числа графика в Excel */}
          <div className="save-menu">
            <button disabled={!rows.length} className={saveMenu ? "on" : ""} onClick={() => setSaveMenu(!saveMenu)} onBlur={() => setTimeout(() => setSaveMenu(false), 150)} title="Сохранить график"><Icon name="download" size={14} />Скачать<Icon name="chevronDown" size={12} /></button>
            {saveMenu && (
              <div className="save-list" onMouseDown={(e) => e.preventDefault()}>
                <button onClick={() => { setSaveMenu(false); if (canvas.current) savePng(base() + `_${kind}.png`, canvas.current); }}><b>PNG</b><small>картинка графика</small></button>
                <button onClick={() => { setSaveMenu(false); exportPdf(); }}><b>PDF</b><small>график и таблица на листе A4</small></button>
                <button onClick={() => { setSaveMenu(false); exportChartXlsx(); }}><b>Excel</b><small>числа графика и таблица расчета</small></button>
              </div>
            )}
          </div>
        </div>
        <div className="chart-box"><canvas ref={canvas} />{!rows.length && <p className="hint center">Здесь будет график по участкам из таблицы</p>}</div>
      </div>
    </div>
  );
}

function NormsEditor() {
  const norms = useEditor((s) => s.norms);
  const setNorms = useEditor((s) => s.setNorms);
  // число применяется сразу при вводе, с небольшой паузой, чтобы большой город не пересчитывался на каждую цифру
  const timer = useRef<number>(0);
  const upd = (patch: Partial<Norms>) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const cur = useEditor.getState().norms;
      setNorms({ ...cur, ...patch, laneCapacity: { ...cur.laneCapacity, ...patch.laneCapacity }, surfaceK: { ...cur.surfaceK, ...patch.surfaceK } });
    }, 250);
  };
  // пустое или неверное число не применяем, пока пользователь еще печатает
  const num = (v: string) => { const x = Number(v.replace(",", ".")); return v.trim() === "" || !isFinite(x) ? null : x; };
  const isDefault = JSON.stringify(norms) === JSON.stringify(DEFAULT_NORMS);
  // после сброса поля создаются заново, чтобы показать стандартные числа
  const [resets, setResets] = useState(0);
  return (
    <div className="norms">
      <table className="tbl">
        <thead><tr><th>Класс дороги</th><th className="r">Полоса, авт/ч</th></tr></thead>
        <tbody>
          {Object.entries(norms.laneCapacity).map(([k, v]) => (
            <tr key={k}><td>{k === "link" ? "Съезды" : ROAD_CLASSES[k]?.ru ?? k}</td><td className="r"><input type="number" defaultValue={v} key={"c" + k + resets} onChange={(e) => { const x = num(e.target.value); if (x !== null && x >= 1) upd({ laneCapacity: { [k]: x } }); }} /></td></tr>
          ))}
        </tbody>
      </table>
      <table className="tbl">
        <thead><tr><th>Покрытие</th><th className="r">Коэффициент скорости</th></tr></thead>
        <tbody>
          {Object.entries(norms.surfaceK).map(([k, v]) => (
            <tr key={k}><td>{SURFACES[k]?.ru ?? k}</td><td className="r"><input type="number" step="0.05" defaultValue={v} key={"s" + k + resets} onChange={(e) => { const x = num(e.target.value); if (x !== null && x > 0 && x <= 1) upd({ surfaceK: { [k]: x } }); }} /></td></tr>
          ))}
        </tbody>
      </table>
      <table className="tbl">
        <thead><tr><th>Порог Z</th><th className="r">От</th></tr></thead>
        <tbody>
          {(["z1", "z2", "z3"] as const).map((k, i) => (
            <tr key={k}><td><span className="zpill" style={{ background: `rgb(${Z_COLORS[i + 1].join(",")})` }}>{Z_TEXT[i + 1]}</span></td><td className="r"><input type="number" step="0.05" key={k + resets} defaultValue={norms[k]} onChange={(e) => { const x = num(e.target.value); if (x !== null && x > 0) upd({ [k]: x }); }} /></td></tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        Значения условные. Пропускную способность, коэффициенты покрытия и пороги задают транспортники по нормативам.
        Изменения сразу видны в таблице, на карте «Загрузка Z» и в свойствах дороги, и запоминаются до следующего запуска.
      </p>
      <div className="chips"><button disabled={isDefault} onClick={() => { window.clearTimeout(timer.current); setNorms(DEFAULT_NORMS); setResets(resets + 1); }}>Сбросить к стандартным</button></div>
    </div>
  );
}
