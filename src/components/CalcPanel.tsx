import { useEffect, useRef, useState, type ReactNode } from "react";
import { Chart, registerables } from "chart.js";
import { useEditor, setWayTags, setMeasures } from "../model/store";
import { readFcd, fcdMeasures } from "../model/fcd";
import { calcWay, clampPhi, DEFAULT_NORMS, MEASURE_KEYS, PHI_MAX, PHI_MIN, PHI_REF, zLevel, Z_COLORS, Z_TEXT, type CalcResult, type Norms } from "../model/calc";
import { SURFACES, ROAD_CLASSES, wayName, isDrivable } from "../model/roads";
import { saveCsv, savePdf, savePng, saveXlsx, toCsv } from "../model/exporting";
import type { Cell } from "../model/xlsx";
import { flowCurve, flowPoint, FLOW_AXES, FLOW_SHORT, FLOW_TITLES, type FlowKind } from "../model/flow";
import Icon from "./Icon";
import { locale, tr, useLang } from "../i18n";

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

const fmt = (x: number | null, n = 0) => (x === null || !isFinite(x) ? "-" : x.toLocaleString(locale(), { minimumFractionDigits: n, maximumFractionDigits: n }));
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
  const langId = useLang((s) => s.lang); // язык: подписи графика перерисовываются

  const ids = analysis.filter((id) => data?.ways.has(id));
  const rows: Row[] = data ? ids.map((id) => { const w = data.ways.get(id)!; return { id, name: wayName(w), c: calcWay(data, w, norms) }; }) : [];
  if (sort) rows.sort((a, b) => compareRows(a, b, sort.key, sort.dir));
  // клик по заголовку: по возрастанию, потом по убыванию, потом как добавляли
  const clickSort = (key: SortKey) => setSort(!sort || sort.key !== key ? { key, dir: 1 } : sort.dir === 1 ? { key, dir: -1 } : null);
  const Th = ({ k, children, title }: { k: SortKey; children: ReactNode; title?: string }) => (
    <th className={"sortable" + (k === "name" ? "" : " r") + (sort?.key === k ? " sorted" : "")} title={title ?? tr("Сортировать")} onClick={() => clickSort(k)}>
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
        ? [{ label: tr("Коэффициент загрузки Z"), data: rows.map((r) => r.c.Z ?? 0), backgroundColor: rows.map((r) => (r.c.Z === null ? "rgba(160,160,160,.5)" : rgb(Z_COLORS[zLevel(r.c.Z, norms)]))) }]
        : kind === "time"
          ? [
              { label: tr("T своб, мин"), data: rows.map((r) => +r.c.Tfree.toFixed(2)), backgroundColor: "rgba(63,157,90,.85)" },
              { label: tr("T факт, мин"), data: rows.map((r) => r.c.Tfact ?? 0), backgroundColor: "rgba(216,64,47,.85)" },
            ]
          : [
              { label: tr("V своб, км/ч"), data: rows.map((r) => +r.c.Vfree.toFixed(1)), backgroundColor: "rgba(31,111,209,.85)" },
              { label: tr("V ср, км/ч"), data: rows.map((r) => (r.c.Vavg === null ? 0 : +r.c.Vavg.toFixed(1))), backgroundColor: "rgba(229,154,40,.85)" },
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
      const [ax, ay] = FLOW_AXES[kind].map((x) => tr(x));
      chart.current = new Chart(canvas.current, {
        type: "scatter",
        data: {
          datasets: [
            { label: tr("Модель: {0}", ref.name), data: flowCurve(kind, ref.c), showLine: true, pointRadius: kind === "Tt" ? 3 : 0, borderColor: "rgba(31,111,209,.9)", backgroundColor: "rgba(31,111,209,.9)", borderWidth: 2, tension: 0.3 },
            ...(pts.length ? [{ label: tr("Участки по замерам"), data: pts.map((x) => ({ ...x.p!, name: x.r.name })), pointRadius: 5, backgroundColor: "rgba(216,64,47,.85)", borderColor: "rgba(216,64,47,1)" }] : []),
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { position: "bottom", labels: { color: fg, boxWidth: 12 } },
            title: { display: true, color: fg, font: { weight: 600 }, text: FLOW_TITLES[kind] + (kind !== "Tt" && !pts.length ? tr(" (замеров нет, только модель)") : "") },
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
          title: { display: true, color: fg, font: { weight: 600 }, text: kind === "z" ? tr("Загрузка участков (пороги: {0} / {1} / {2})", norms.z1, norms.z2, norms.z3) : kind === "time" ? tr("Время проезда: свободное и фактическое") : tr("Скорость: свободная и средняя") },
        },
        scales: { x: { ticks: { color: muted }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: muted }, grid: { color: grid } } },
      },
      plugins: [bgPlugin],
    });
  }, [kind, version, norms, analysis.join(), theme, sort?.key, sort?.dir, selection, langId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => chart.current?.destroy(), []);

  if (!data) return <p className="hint pad">{tr("Откройте файл .osm")}</p>;

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
    setWayTags(id, tags, key === MEASURE_KEYS.volume ? tr("Замер N") : tr("Замер T факт"));
  };
  // Результаты SUMO: выбираем fcd.xml прогона, записываем N и T факт в дороги и добавляем их в таблицу
  const loadFcd = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".xml";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const toast = useEditor.getState().toast;
      const list = fcdMeasures(data, readFcd(await f.text()));
      if (!list.length) return toast(tr("В файле нет машин на дорогах этого графа. Нужен fcd.xml прогона этого же графа"));
      setMeasures(list, tr("Замеры из прогона SUMO"));
      setAnalysis([...new Set([...analysis, ...list.map((m) => m.id)])]);
      toast(tr("Из прогона SUMO заполнено дорог: {0}", list.length));
    };
    inp.click();
  };
  // Таблица расчета для выгрузки: заголовок и строки (одна и та же для CSV, Excel и PDF)
  const TABLE_HEAD = ["way id", tr("Дорога"), tr("L, км"), tr("V max, км/ч"), tr("φ сцепления"), tr("k скорости"), tr("V своб, км/ч"), tr("T своб, мин"), tr("Полос"), tr("P, авт/ч"), tr("N, авт/ч"), tr("T факт, мин"), "Z", tr("Загрузка"), tr("V ср, км/ч"), tr("q, авт/км"), tr("T зад, мин"), "D, %"];
  const tableRows = (): Cell[][] => {
    const r = (x: number | null, n: number) => (x === null || !isFinite(x) ? null : +x.toFixed(n));
    return rows.map(({ id, name, c }) => [id, name, r(c.L, 3), c.Vmax, c.phi, r(c.kSurface, 3), r(c.Vfree, 1), r(c.Tfree, 2), c.lanes, c.P, c.N, c.Tfact, r(c.Z, 2), c.Z === null ? "" : tr(Z_TEXT[zLevel(c.Z, norms)]), r(c.Vavg, 1), r(c.q, 1), r(c.Tdelay, 2), r(c.D, 0)]);
  };
  const base = () => fileName.replace(/\.osm$/i, "");
  const exportCsv = () => saveCsv(base() + "_calc.csv", toCsv(TABLE_HEAD, tableRows()));
  const exportXlsx = () => saveXlsx(base() + "_calc.xlsx", [{ name: tr("Расчет"), rows: [TABLE_HEAD, ...tableRows()] }, ...(chart.current ? [{ name: tr("График"), rows: chartRows() }] : [])]);

  // Числа текущего графика: у столбиков - участок и значения рядов, у диаграмм - точки x, y каждого ряда
  const chartTitle = () => String((chart.current?.options.plugins?.title as { text?: string } | undefined)?.text ?? tr("График"));
  const chartRows = (): Cell[][] => {
    const ch = chart.current;
    if (!ch) return [];
    const r = (x: unknown) => (typeof x === "number" && isFinite(x) ? +x.toFixed(3) : null);
    const sets = ch.data.datasets;
    if (ch.data.labels?.length) {
      return [[tr("Участок"), ...sets.map((d) => d.label ?? "")], ...ch.data.labels.map((l, i) => [String(l), ...sets.map((d) => r(d.data[i]))])];
    }
    const [ax, ay] = isFlow(kind) ? FLOW_AXES[kind].map((x) => tr(x)) : ["x", "y"];
    const out: Cell[][] = [[tr("Ряд"), ax, ay]];
    for (const d of sets) for (const p of d.data as { x: number; y: number }[]) out.push([d.label ?? "", r(p.x), r(p.y)]);
    return out;
  };
  const exportChartXlsx = () => saveXlsx(base() + `_${kind}.xlsx`, [{ name: tr("График"), rows: chartRows() }, { name: tr("Расчет"), rows: [TABLE_HEAD, ...tableRows()] }]);

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
    const num = (x: Cell) => (typeof x === "number" ? x.toLocaleString(locale()) : esc(x));
    const html = tr("<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>{0}</title><style>\n      body { font: 11px/1.4 -apple-system, \"Segoe UI\", Roboto, Arial, sans-serif; color: #1d2125; margin: 0; }\n      h1 { font-size: 17px; margin: 0 0 2px; } .sub { color: #6b7178; margin-bottom: 12px; }\n      img { display: block; max-width: 100%; max-height: 90mm; margin: 0 auto 14px; border-radius: 6px; }\n      table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #d5d8dc; padding: 3px 5px; text-align: right; }\n      th { background: #eef0f2; font-weight: 600; } td:nth-child(2), th:nth-child(2) { text-align: left; } tr { page-break-inside: avoid; }\n    </style></head><body>\n      <h1>{1}</h1>\n      <div class=\"sub\">Wayfinder · {2} · {3} · участков: {4}</div>\n      <img src=\"{5}\">\n      <table><thead><tr>{6}</tr></thead>\n      <tbody>{7}</tbody></table>\n    </body></html>", esc(chartTitle()), esc(chartTitle()), esc(fileName), new Date().toLocaleString(locale()), rows.length, bg.toDataURL("image/png"), TABLE_HEAD.slice(1).map((h) => `<th>${esc(h)}</th>`).join(""), tableRows().map((r) => `<tr>${r.slice(1).map((x) => `<td>${num(x)}</td>`).join("")}</tr>`).join(""));
    savePdf(base() + `_${kind}.pdf`, html);
  };
  const [saveMenu, setSaveMenu] = useState(false);

  return (
    <div className="calc">
      <div className="calc-left">
        <div className="chips">
          {selWay && isDrivable(selWay) && !analysis.includes(selWay.id) && <button className="on" onClick={() => setAnalysis([...analysis, selWay.id])}><Icon name="plus" size={14} />{tr("Выделенная:")}{" "}{wayName(selWay)}</button>}
          {selMany.length > 0 && <button className="on" onClick={() => setAnalysis([...analysis, ...selMany])}><Icon name="plus" size={14} />{tr("Выделенные:")}{" "}{selMany.length}</button>}
          <button onClick={addMajor}><Icon name="plus" size={14} />{tr("Все крупные улицы")}</button>
          <button onClick={loadFcd} title={tr("Выберите fcd.xml с сервера проверки. N и T факт по каждой дороге посчитаются по движению машин в SUMO")}><Icon name="folder" size={14} />{tr("Из прогона SUMO...")}</button>
          {rows.length > 0 && <button onClick={() => setAnalysis([])}>{tr("Очистить")}</button>}
          <button onClick={exportCsv} disabled={!rows.length} title={tr("Таблица для Excel и других программ")}><Icon name="download" size={14} />CSV</button>
          <button onClick={exportXlsx} disabled={!rows.length} title={tr("Таблица Excel: лист «Расчет» и лист «График» с числами графика")}><Icon name="download" size={14} />Excel</button>
          <button className={showNorms ? "on" : ""} onClick={() => setShowNorms(!showNorms)}>{tr("Нормативы")}</button>
        </div>
        {showNorms ? <NormsEditor /> : (
          <div className="tbl-wrap">
            <table className="tbl calc-tbl">
              <thead>
                <tr>
                  <Th k="name">{tr("Участок")}</Th><Th k="L">{tr("L, км")}</Th><Th k="Vfree">{tr("V своб")}</Th><Th k="Tfree">{tr("T своб, мин")}</Th><Th k="P">P</Th><Th k="N">{tr("N, авт/ч")}</Th>
                  <Th k="Tfact">{tr("T факт, мин")}</Th><Th k="Z">Z</Th><Th k="Vavg">{tr("V ср")}</Th><Th k="q">q</Th><Th k="Tdelay">{tr("T зад")}</Th><Th k="D">D, %</Th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ id, name, c }) => (
                  <tr key={id} className={selection?.kind === "way" && selection.id === id ? "sel" : ""}>
                    <td className="click" onClick={() => select({ kind: "way", id })}>{name}</td>
                    <td className="r">{fmt(c.L, 3)}</td>
                    <td className="r" title={`${c.Vmax} × √(${c.phi} / ${PHI_REF}) = ${c.Vmax} × ${c.kSurface.toFixed(2)}`}>{fmt(c.Vfree, 1)}</td>
                    <td className="r"><b>{fmt(c.Tfree, 2)}</b></td>
                    <td className="r">{fmt(c.P)}</td>
                    <td className="r"><input defaultValue={c.N ?? ""} key={"n" + id + c.N} placeholder={tr("Замер")} onBlur={(e) => e.target.value !== String(c.N ?? "") && setMeasure(id, MEASURE_KEYS.volume, e.target.value)} /></td>
                    <td className="r"><input defaultValue={c.Tfact ?? ""} key={"t" + id + c.Tfact} placeholder={tr("Замер")} onBlur={(e) => e.target.value !== String(c.Tfact ?? "") && setMeasure(id, MEASURE_KEYS.time, e.target.value)} /></td>
                    <td className="r">{c.Z === null ? "-" : <span className="zpill" style={{ background: `rgb(${Z_COLORS[zLevel(c.Z, norms)].join(",")})` }}>{fmt(c.Z, 2)}</span>}</td>
                    <td className="r">{fmt(c.Vavg, 1)}</td>
                    <td className="r">{fmt(c.q, 0)}</td>
                    <td className="r">{fmt(c.Tdelay, 2)}</td>
                    <td className="r">{fmt(c.D, 0)}</td>
                    <td><button className="x" title={tr("Убрать")} onClick={() => setAnalysis(analysis.filter((x) => x !== id))}><Icon name="close" size={14} /></button></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={13} className="muted">{tr("Добавьте участки: выделите дорогу и нажмите «+ Выделенная» или добавьте все крупные улицы.")}</td></tr>}
              </tbody>
            </table>
            <p className="hint">{tr("Как считается каждая величина, смотрите на вкладке «Формулы». Замеры N и T факт сохраняются в .osm.")}</p>
          </div>
        )}
      </div>
      <div className="calc-right">
        <div className="chips">
          <div className="seg">
            {([["z", tr("Загрузка Z")], ["time", tr("Время")], ["speed", tr("Скорость")]] as const).map(([k, l]) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{l}</button>)}
          </div>
          {/* диаграммы потока: модельная кривая выбранного участка и точки замеров */}
          <select className={isFlow(kind) ? "on" : ""} value={isFlow(kind) ? kind : ""} onChange={(e) => e.target.value && setKind(e.target.value as FlowKind)} title={tr("Диаграммы транспортного потока: модель для выбранного участка (или первого в таблице) и участки с замерами")}>
            <option value="">{tr("Диаграммы потока...")}</option>
            {FLOW_KINDS.map((k) => <option key={k} value={k}>{FLOW_SHORT[k]}: {FLOW_TITLES[k].split(": ").pop()}</option>)}
          </select>
          {/* сохранить график: картинка, PDF с таблицей или числа графика в Excel */}
          <div className="save-menu">
            <button disabled={!rows.length} className={saveMenu ? "on" : ""} onClick={() => setSaveMenu(!saveMenu)} onBlur={() => setTimeout(() => setSaveMenu(false), 150)} title={tr("Сохранить график")}><Icon name="download" size={14} />{tr("Скачать")}<Icon name="chevronDown" size={12} /></button>
            {saveMenu && (
              <div className="save-list" onMouseDown={(e) => e.preventDefault()}>
                <button onClick={() => { setSaveMenu(false); if (canvas.current) savePng(base() + `_${kind}.png`, canvas.current); }}><b>PNG</b><small>{tr("картинка графика")}</small></button>
                <button onClick={() => { setSaveMenu(false); exportPdf(); }}><b>PDF</b><small>{tr("график и таблица на листе A4")}</small></button>
                <button onClick={() => { setSaveMenu(false); exportChartXlsx(); }}><b>Excel</b><small>{tr("числа графика и таблица расчета")}</small></button>
              </div>
            )}
          </div>
        </div>
        <div className="chart-box"><canvas ref={canvas} />{!rows.length && <p className="hint center">{tr("Здесь будет график по участкам из таблицы")}</p>}</div>
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
      setNorms({ ...cur, ...patch, laneCapacity: { ...cur.laneCapacity, ...patch.laneCapacity }, friction: { ...cur.friction, ...patch.friction } });
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
        <thead><tr><th>{tr("Класс дороги")}</th><th className="r">{tr("Полоса, авт/ч")}</th></tr></thead>
        <tbody>
          {Object.entries(norms.laneCapacity).map(([k, v]) => (
            <tr key={k}><td>{k === "link" ? tr("Съезды") : ROAD_CLASSES[k]?.ru ?? k}</td><td className="r"><input type="number" defaultValue={v} key={"c" + k + resets} onChange={(e) => { const x = num(e.target.value); if (x !== null && x >= 1) upd({ laneCapacity: { [k]: x } }); }} /></td></tr>
          ))}
        </tbody>
      </table>
      <table className="tbl">
        <thead><tr><th>{tr("Покрытие")}</th><th className="r" title={tr("Коэффициент сцепления шины с покрытием, от {0} до {1}", PHI_MIN, PHI_MAX)}>{tr("Сцепление φ")}</th></tr></thead>
        <tbody>
          {Object.entries(norms.friction).map(([k, v]) => (
            // число вне 0,1-1 приводится к границе: при вводе применяется сразу, при выходе из поля исправляется и в поле
            <tr key={k}><td>{SURFACES[k]?.ru ?? k}</td><td className="r"><input type="number" step="0.05" min={PHI_MIN} max={PHI_MAX} defaultValue={v} key={"s" + k + resets} onChange={(e) => { const x = num(e.target.value); const c = x === null ? null : clampPhi(x); if (c !== null) upd({ friction: { [k]: c } }); }} onBlur={(e) => { const x = num(e.target.value); const c = x === null ? null : clampPhi(x); e.target.value = String(c ?? v); }} /></td></tr>
          ))}
        </tbody>
      </table>
      <table className="tbl">
        <thead><tr><th>{tr("Порог Z")}</th><th className="r">{tr("От")}</th></tr></thead>
        <tbody>
          {(["z1", "z2", "z3"] as const).map((k, i) => (
            <tr key={k}><td><span className="zpill" style={{ background: `rgb(${Z_COLORS[i + 1].join(",")})` }}>{tr(Z_TEXT[i + 1])}</span></td><td className="r"><input type="number" step="0.05" key={k + resets} defaultValue={norms[k]} onChange={(e) => { const x = num(e.target.value); if (x !== null && x > 0) upd({ [k]: x }); }} /></td></tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        {tr("Значения условные. Коэффициент сцепления φ от 0,1 (лед) до 1, для сухого асфальта 0,8: при нем скорость не снижается, при меньшем V своб = V max · √(φ / 0,8). Свое φ можно задать и отдельной дороге (панель дороги). Пропускную способность, коэффициенты сцепления и пороги задают транспортники по нормативам. Изменения сразу видны в таблице, на карте «Загрузка Z» и в свойствах дороги, и запоминаются до следующего запуска.")}</p>
      <div className="chips"><button disabled={isDefault} onClick={() => { window.clearTimeout(timer.current); setNorms(DEFAULT_NORMS); setResets(resets + 1); }}>{tr("Сбросить к стандартным")}</button></div>
    </div>
  );
}
