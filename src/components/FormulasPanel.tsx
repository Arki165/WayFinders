// Вкладка "Формулы": как считается каждая величина в расчетах.
// Формулы те же, что в src/model/calc.ts.
import type { ReactNode } from "react";
import { useEditor } from "../model/store";
import { Z_COLORS, Z_TEXT } from "../model/calc";
import { isDrivable } from "../model/roads";
import { tr } from "../i18n";

// величина с нижним индексом, например V своб
function V({ n, s }: { n: string; s?: string }) {
  return <span className="fv"><i>{n}</i>{s && <sub>{s}</sub>}</span>;
}

// дробь: числитель над знаменателем
function Frac({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  return <span className="frac"><span>{top}</span><span>{bottom}</span></span>;
}

function Card({ title, formula, children }: { title: string; formula: ReactNode; children: ReactNode }) {
  return (
    <div className="fcard">
      <h4>{title}</h4>
      <div className="formula">{formula}</div>
      <div className="where">{children}</div>
    </div>
  );
}

const fmt = (x: number) => String(x).replace(".", ",");

export default function FormulasPanel() {
  const norms = useEditor((s) => s.norms);
  const data = useEditor((s) => s.data);
  const selection = useEditor((s) => s.selection);
  const analysis = useEditor((s) => s.analysis);
  const setAnalysis = useEditor((s) => s.setAnalysis);
  // выделенные дороги: по ним формулы считаются на вкладке «Расчеты и графики»
  const picked = (selection?.kind === "way" ? [selection.id] : selection?.kind === "ways" ? selection.ids : []).filter((id) => { const w = data?.ways.get(id); return !!w && isDrivable(w); });
  const calc = () => {
    setAnalysis([...new Set([...analysis, ...picked])]);
    window.dispatchEvent(new CustomEvent("wf-open-calc"));
  };
  const zones = [
    `Z < ${fmt(norms.z1)}`,
    `${fmt(norms.z1)} ≤ Z < ${fmt(norms.z2)}`,
    `${fmt(norms.z2)} ≤ Z < ${fmt(norms.z3)}`,
    `Z ≥ ${fmt(norms.z3)}`,
  ];

  return (
    <div className="formulas">
      <div className="fcalc">
        <span>{picked.length ? tr("Выделено дорог: {0}. Формулы посчитаются по их длине, полосам, скорости и замерам.", picked.length) : tr("Выделите дорогу на карте (участок: Shift+клик по второму узлу) и посчитайте формулы для нее. Интенсивность и время проезда вводятся в таблице расчета.")}</span>
        <button className="primary" disabled={!picked.length} onClick={calc}>{tr("Посчитать для выделенного")}</button>
      </div>
      <Card title={tr("Скорость свободного движения, км/ч")} formula={<><V n="V" s={tr("своб")} /> = <V n="V" s="max" /> · <V n="k" s={tr("покр")} /></>}>
        <V n="V" s="max" /> {" "}{tr("- разрешенная скорость (тег maxspeed, если его нет - по классу дороги);")}<br />
        <V n="k" s={tr("покр")} /> {" "}{tr("- коэффициент покрытия: асфальт 1, грунт 0,5 (вкладка «Нормативы»).")}</Card>

      <Card title={tr("Время свободного проезда, мин")} formula={<><V n="T" s={tr("своб")} /> = <Frac top={<V n="L" />} bottom={<V n="V" s={tr("своб")} />} /> · 60</>}>
        <V n="L" /> {" "}{tr("- длина участка, км. Считается только по карте, замеры не нужны.")}</Card>

      <Card title={tr("Пропускная способность, авт/ч")} formula={<><V n="P" /> = <V n="n" /> · <V n="P" s={tr("пол")} /></>}>
        <V n="n" /> {" "}{tr("- число полос;")}<br />
        <V n="P" s={tr("пол")} /> {" "}{tr("- пропускная способность одной полосы для класса дороги (вкладка «Нормативы»).")}</Card>

      <Card title={tr("Коэффициент загрузки")} formula={<><V n="Z" /> = <Frac top={<V n="N" />} bottom={<V n="P" />} /></>}>
        <V n="N" /> {" "}{tr("- интенсивность движения, авт/ч (замер).")}<div className="zones">
          {zones.map((z, i) => (
            <span key={i}><b className="zpill" style={{ background: `rgb(${Z_COLORS[i].join(",")})` }}>{tr(Z_TEXT[i])}</b> {z}</span>
          ))}
        </div>
      </Card>

      <Card title={tr("Средняя скорость, км/ч")} formula={<><V n="V" s={tr("ср")} /> = <Frac top={<V n="L" />} bottom={<V n="T" s={tr("факт")} />} /> · 60</>}>
        <V n="T" s={tr("факт")} /> {" "}{tr("- фактическое время проезда участка, мин (замер).")}</Card>

      <Card title={tr("Плотность потока, авт/км")} formula={<><V n="q" /> = <Frac top={<V n="N" />} bottom={<V n="V" s={tr("ср")} />} /></>}>
        {tr("Сколько машин в среднем находится на километре дороги.")}</Card>

      <Card title={tr("Время задержки, мин")} formula={<><V n="T" s={tr("зад")} /> = <V n="T" s={tr("факт")} /> − <V n="T" s={tr("своб")} /></>}>
        {tr("Сколько времени теряется по сравнению с пустой дорогой.")}</Card>

      <Card title={tr("Относительная задержка, %")} formula={<><V n="D" /> = <Frac top={<><V n="T" s={tr("факт")} /> − <V n="T" s={tr("своб")} /></>} bottom={<V n="T" s={tr("своб")} />} /> · 100%</>}>
        {tr("На сколько процентов поездка дольше, чем по пустой дороге.")}</Card>

      <Card title={tr("Модель потока Гриншилдса (диаграммы N(q), V(q), V(N), D(q))")} formula={<><V n="V" /> = <V n="V" s={tr("своб")} /> · (1 − <Frac top={<V n="q" />} bottom={<V n="q" s={tr("зат")} />} />), <V n="N" /> = <V n="q" /> · <V n="V" /></>}>
        <V n="q" s={tr("зат")} /> {" "}{tr("- плотность затора:")}{" "}<V n="q" s={tr("зат")} /> = <Frac top={<>4<V n="P" /></>} bottom={<V n="V" s={tr("своб")} />} />{tr(", тогда наибольший поток равен пропускной способности")}{" "}<V n="P" />{tr(". Скорость падает с ростом плотности, поток растет до")}{" "}<V n="P" /> {" "}{tr("при")}{" "}<V n="q" s={tr("зат")} />{tr("/2 и дальше падает (затор).")}</Card>

      <Card title={tr("Задержка от загрузки (диаграммы D(Z) и T зад(t))")} formula={<><V n="T" /> = <V n="T" s={tr("своб")} /> · (1 + 0,15 · <V n="Z" /><sup>4</sup>)</>}>
        {tr("Формула BPR: до")}{" "}<V n="Z" /> {" "}{tr("≈ 0,7 задержка мала, ближе к 1 резко растет. Задержка в течение суток: интенсивность по часам из типового городского профиля (пики в 8 и 17 ч), замер")}{" "}<V n="N" /> {" "}{tr("считается пиковым.")}</Card>

      <p className="hint fnote">{tr("Замеры")}{" "}<V n="N" /> {" "}{tr("и")}{" "}<V n="T" s={tr("факт")} /> {" "}{tr("вводятся в таблице на вкладке «Расчеты и графики» и сохраняются в .osm в тегах wayfinders:volume и wayfinders:travel_time.")}</p>
    </div>
  );
}
