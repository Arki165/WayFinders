// Вкладка "Формулы": как считается каждая величина в расчетах.
// Формулы те же, что в src/model/calc.ts.
import type { ReactNode } from "react";
import { useEditor } from "../model/store";
import { Z_COLORS, Z_TEXT } from "../model/calc";

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
  const zones = [
    `Z < ${fmt(norms.z1)}`,
    `${fmt(norms.z1)} ≤ Z < ${fmt(norms.z2)}`,
    `${fmt(norms.z2)} ≤ Z < ${fmt(norms.z3)}`,
    `Z ≥ ${fmt(norms.z3)}`,
  ];

  return (
    <div className="formulas">
      <Card title="Скорость свободного движения, км/ч" formula={<><V n="V" s="своб" /> = <V n="V" s="max" /> · <V n="k" s="покр" /></>}>
        <V n="V" s="max" /> - разрешенная скорость (тег maxspeed, если его нет - по классу дороги);<br />
        <V n="k" s="покр" /> - коэффициент покрытия: асфальт 1, грунт 0,5 (вкладка «Нормативы»).
      </Card>

      <Card title="Время свободного проезда, мин" formula={<><V n="T" s="своб" /> = <Frac top={<V n="L" />} bottom={<V n="V" s="своб" />} /> · 60</>}>
        <V n="L" /> - длина участка, км. Считается только по карте, замеры не нужны.
      </Card>

      <Card title="Пропускная способность, авт/ч" formula={<><V n="P" /> = <V n="n" /> · <V n="P" s="пол" /></>}>
        <V n="n" /> - число полос;<br />
        <V n="P" s="пол" /> - пропускная способность одной полосы для класса дороги (вкладка «Нормативы»).
      </Card>

      <Card title="Коэффициент загрузки" formula={<><V n="Z" /> = <Frac top={<V n="N" />} bottom={<V n="P" />} /></>}>
        <V n="N" /> - интенсивность движения, авт/ч (замер).
        <div className="zones">
          {zones.map((z, i) => (
            <span key={i}><b className="zpill" style={{ background: `rgb(${Z_COLORS[i].join(",")})` }}>{Z_TEXT[i]}</b> {z}</span>
          ))}
        </div>
      </Card>

      <Card title="Средняя скорость, км/ч" formula={<><V n="V" s="ср" /> = <Frac top={<V n="L" />} bottom={<V n="T" s="факт" />} /> · 60</>}>
        <V n="T" s="факт" /> - фактическое время проезда участка, мин (замер).
      </Card>

      <Card title="Плотность потока, авт/км" formula={<><V n="q" /> = <Frac top={<V n="N" />} bottom={<V n="V" s="ср" />} /></>}>
        Сколько машин в среднем находится на километре дороги.
      </Card>

      <Card title="Время задержки, мин" formula={<><V n="T" s="зад" /> = <V n="T" s="факт" /> − <V n="T" s="своб" /></>}>
        Сколько времени теряется по сравнению с пустой дорогой.
      </Card>

      <Card title="Относительная задержка, %" formula={<><V n="D" /> = <Frac top={<><V n="T" s="факт" /> − <V n="T" s="своб" /></>} bottom={<V n="T" s="своб" />} /> · 100%</>}>
        На сколько процентов поездка дольше, чем по пустой дороге.
      </Card>

      <Card title="Модель потока Гриншилдса (диаграммы N(q), V(q), V(N), D(q))" formula={<><V n="V" /> = <V n="V" s="своб" /> · (1 − <Frac top={<V n="q" />} bottom={<V n="q" s="зат" />} />), <V n="N" /> = <V n="q" /> · <V n="V" /></>}>
        <V n="q" s="зат" /> - плотность затора: <V n="q" s="зат" /> = <Frac top={<>4<V n="P" /></>} bottom={<V n="V" s="своб" />} />, тогда наибольший поток равен пропускной способности <V n="P" />.
        Скорость падает с ростом плотности, поток растет до <V n="P" /> при <V n="q" s="зат" />/2 и дальше падает (затор).
      </Card>

      <Card title="Задержка от загрузки (диаграммы D(Z) и T зад(t))" formula={<><V n="T" /> = <V n="T" s="своб" /> · (1 + 0,15 · <V n="Z" /><sup>4</sup>)</>}>
        Формула BPR: до <V n="Z" /> ≈ 0,7 задержка мала, ближе к 1 резко растет.
        Задержка в течение суток: интенсивность по часам из типового городского профиля (пики в 8 и 17 ч), замер <V n="N" /> считается пиковым.
      </Card>

      <p className="hint fnote">Замеры <V n="N" /> и <V n="T" s="факт" /> вводятся в таблице на вкладке «Расчеты и графики» и сохраняются в .osm в тегах wayfinders:volume и wayfinders:travel_time.</p>
    </div>
  );
}
