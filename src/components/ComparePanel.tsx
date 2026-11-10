import { useMemo } from "react";
import { useEditor } from "../model/store";
import { diffData, summary } from "../model/diff";
import { validate } from "../model/validate";
import { toCsv, saveCsv } from "../model/exporting";

export default function ComparePanel() {
  const data = useEditor((s) => s.data);
  const original = useEditor((s) => s.original);
  const check = useEditor((s) => s.check);
  const version = useEditor((s) => s.version);
  const select = useEditor((s) => s.select);
  const flyTo = useEditor((s) => s.flyTo);
  const fileName = useEditor((s) => s.fileName);

  const before = useMemo(() => (original ? { s: summary(original), v: validate(original) } : null), [original]);
  const now = useMemo(() => (data ? { s: summary(data), d: diffData(original!, data) } : null), [data, original, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !before || !now || !check) return <p className="hint pad">Откройте файл .osm</p>;

  const cnt = (errs: { sev: string }[], s: string) => errs.filter((e) => e.sev === s).length;
  const pct = (v: { sccMain: number; nodes: number }) => (v.nodes ? (v.sccMain / v.nodes) * 100 : 100);
  const rows: [string, number, number, number, number][] = [
    // название, было, стало, знак "хорошо" (+1 больше лучше, -1 меньше лучше, 0 нейтрально), знаков после запятой
    ["Критичных ошибок", cnt(before.v.errors, "danger"), cnt(check.errors, "danger"), -1, 0],
    ["Предупреждений", cnt(before.v.errors, "warn"), cnt(check.errors, "warn"), -1, 0],
    ["Связность по направлениям, %", pct(before.v), pct(check), 1, 1],
    ["Проезжих дорог", before.s.roads, now.s.roads, 0, 0],
    ["Дорог с числом полос", before.s.withLanes, now.s.withLanes, 1, 0],
    ["Дорог со скоростью", before.s.withSpeed, now.s.withSpeed, 1, 0],
    ["Дорог с покрытием", before.s.withSurface, now.s.withSurface, 1, 0],
    ["Односторонних дорог", before.s.oneway, now.s.oneway, 0, 0],
    ["Светофоров на дорогах", before.s.signals, now.s.signals, 0, 0],
    ["Светофоров с временем фаз", before.s.signalsTimed, now.s.signalsTimed, 1, 0],
  ];
  const d = now.d;

  const exportCsv = () => {
    const part1 = toCsv(["Показатель", "Исходный файл", "Сейчас", "Изменение"], rows.map(([t, a, b, , n]) => [t, +a.toFixed(n), +b.toFixed(n), +(b - a).toFixed(n)]));
    const part2 = toCsv(["Изменение", "way id", "Дорога", "Что изменилось"], d.ways.map((w) => [w.kind === "added" ? "добавлена" : w.kind === "deleted" ? "удалена" : "изменена", w.id, w.name, w.details.join(", ")])).slice(1);
    saveCsv(fileName.replace(/\.osm$/i, "") + "_changes.csv", part1 + "\r\n\r\n" + part2);
  };
  const goWay = (id: number) => {
    const w = data.ways.get(id);
    if (!w) return;
    select({ kind: "way", id });
    const n = data.nodes.get(w.nodeIds[Math.floor(w.nodeIds.length / 2)]);
    if (n) flyTo(n.lat, n.lon, 17.5);
  };

  return (
    <div className="cmp">
      <table className="tbl">
        <thead><tr><th>Показатель</th><th className="r">Исходный</th><th className="r">Сейчас</th><th className="r">Изменение</th></tr></thead>
        <tbody>
          {rows.map(([t, a, b, good, n]) => {
            const delta = b - a;
            const cls = !delta || !good ? "" : delta * good > 0 ? "good" : "bad";
            return <tr key={t}><td>{t}</td><td className="r">{a.toFixed(n)}</td><td className="r">{b.toFixed(n)}</td><td className={"r " + cls}>{delta ? (delta > 0 ? "+" : "") + delta.toFixed(n) : "-"}</td></tr>;
          })}
        </tbody>
      </table>
      <div className="cmp-list">
        <div className="chips">
          <span className="hint">Дорог: +{d.ways.filter((w) => w.kind === "added").length} / изменено {d.ways.filter((w) => w.kind === "changed").length} / −{d.ways.filter((w) => w.kind === "deleted").length} · узлов перенесено {d.nodesMoved}, добавлено {d.nodesAdded}, удалено {d.nodesDeleted}, изменены теги у {d.nodeTagsChanged}</span>
          <button onClick={exportCsv}>Скачать сравнение CSV</button>
        </div>
        <table className="tbl">
          <tbody>
            {d.ways.slice(0, 150).map((w) => (
              <tr key={w.kind + w.id} className="click" onClick={() => goWay(w.id)}>
                <td><span className={"kind " + w.kind}>{w.kind === "added" ? "добавлена" : w.kind === "deleted" ? "удалена" : "изменена"}</span></td>
                <td>{w.name}</td>
                <td className="muted">{w.details.join(", ")}</td>
              </tr>
            ))}
            {!d.ways.length && <tr><td className="muted">Изменений пока нет</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
