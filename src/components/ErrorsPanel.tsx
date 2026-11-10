import { useState } from "react";
import { useEditor, fixError, fixAllTorn as fixAll } from "../model/store";
import { wayName } from "../model/roads";
import type { GraphError, Severity } from "../model/validate";

const TITLE: Record<GraphError["type"], string> = {
  torn: "Разорванный перекресток",
  glued: "Пересечение без узла",
  isolated: "Изолированный участок",
  trap: "Ловушка по направлениям",
  attr: "Не заполнены атрибуты",
  bridge: "Мост без уровня",
  building: "Дорога сквозь здание",
  long: "Длинный участок без перекрестков",
};
const FIX: Partial<Record<GraphError["type"], string>> = { torn: "Соединить", glued: "Добавить узел", isolated: "Удалить", attr: "Заполнить", bridge: "Поднять мост", building: "Мост над зданием" };
// длина: до 1 км в метрах, дальше в километрах
const km = (m: number) => (m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`);
const ORDER: Record<Severity, number> = { danger: 0, warn: 1, info: 2 };

export default function ErrorsPanel() {
  const data = useEditor((s) => s.data);
  const check = useEditor((s) => s.check);
  const st = useEditor();
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [cur, setCur] = useState<string | null>(null);
  if (!data || !check) return null;

  const nm = (id: number) => wayName(data.ways.get(id));
  const text = (e: GraphError) => {
    switch (e.type) {
      case "torn": return `«${nm(e.ways[0])}» обрывается в ${e.dist!.toFixed(1)} м от «${nm(e.ways[1])}», но не соединена с ней. Машины не смогут здесь проехать.`;
      case "glued": return `«${nm(e.ways[0])}» и «${nm(e.ways[1])}» пересекаются на одном уровне без общего узла: это перекресток или мост.`;
      case "isolated": return e.edge ? `${e.count} узлов не связаны с сетью: кусок обрезан краем карты. Обычно его оставляют.` : `${e.count} узлов не связаны с остальной сетью: машины туда не попадут.`;
      case "trap": return `${e.count} узлов, ${e.ways.length} дорог: въехать можно, а выехать нельзя или наоборот. Проверьте направления движения. MatSim выкинет этот кусок.`;
      case "attr": return `«${nm(e.ways[0])}»: не задано: ${e.miss!.map((k) => (k === "lanes" ? "число полос" : k === "maxspeed" ? "скорость" : k)).join(" и ")}. Симуляторы подставят значения по умолчанию.`;
      case "bridge": return `«${nm(e.ways[0])}» отмечена мостом без уровня: может склеиться с дорогой под ней.`;
      case "long": return `«${nm(e.ways[0])}»: ${km(e.len!)} без перекрестков (для этого класса до ${km(e.limit!)}). Дорогу лучше соединить с соседними. Это предупреждение, оставить можно.`;
      case "building": return `«${nm(e.ways[0])}» проходит сквозь здание: в Webots машины поедут через стену. Перенесите дорогу, сделайте мост или отметьте проезд под домом (арку).`;
    }
  };
  const count = { danger: 0, warn: 0, info: 0 };
  check.errors.forEach((e) => count[e.sev]++);
  const list = check.errors.filter((e) => filter === "all" || e.sev === filter).sort((a, b) => ORDER[a.sev] - ORDER[b.sev]);

  const show = (e: GraphError) => {
    setCur(e.key);
    st.setHighlight(e.ways);
    if (e.ways.length && e.type !== "trap") st.select({ kind: "way", id: e.ways[0] });
    st.flyTo(e.lat, e.lon, e.type === "trap" ? 16.5 : 18);
  };
  // все соединения - одна правка и один Ctrl+Z; граф проверяется один раз, а не после каждого разрыва
  const fixAllTorn = () => {
    const n = fixAll();
    st.toast(`Соединено разрывов: ${n}. Отменить все сразу: Ctrl+Z`);
  };
  const pct = check.nodes ? (check.sccMain / check.nodes) * 100 : 100;

  return (
    <div className="pane">
      <div className={"status " + (count.danger ? "bad" : "good")}>
        {count.danger ? `Критичных ошибок: ${count.danger}. Их стоит исправить до отправки.` : "Критичных ошибок нет. Граф можно сохранять."}
      </div>
      <div className="sumcards">
        {(["danger", "warn", "info"] as const).map((s) => (
          <button key={s} className={filter === s ? "on" : ""} onClick={() => setFilter(filter === s ? "all" : s)}>
            <b className={"c-" + s}>{count[s]}</b>
            <small>{s === "danger" ? "Критичные" : s === "warn" ? "Предупреждения" : "Подсказки"}</small>
          </button>
        ))}
      </div>
      <p className="hint">Связность по направлениям: {pct.toFixed(1)}% узлов в главной сильной компоненте. Компонент связности: {check.components}.</p>
      <div className="chips">
        <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>Все</button>
        {count.danger > 0 && <button onClick={fixAllTorn}>Соединить все разрывы</button>}
      </div>
      {list.map((e) => (
        <div key={e.key} className={"err" + (cur === e.key ? " cur" : "")}>
          <span className={"bar sev-" + e.sev} />
          <div>
            <b>{TITLE[e.type]}</b>
            <p>{text(e)}</p>
            <div className="chips">
              <button onClick={() => show(e)}>Показать</button>
              {FIX[e.type] && !(e.type === "isolated" && e.edge) && <button onClick={() => { fixError(e); st.toast("Исправлено: " + TITLE[e.type].toLowerCase()); }}>{FIX[e.type]}</button>}
              <button onClick={() => st.ignore(e.key)}>{e.type === "isolated" && e.edge ? "Оставить как есть" : "Пропустить"}</button>
            </div>
          </div>
        </div>
      ))}
      {!list.length && <p className="hint">В этой группе ошибок нет.</p>}
    </div>
  );
}
