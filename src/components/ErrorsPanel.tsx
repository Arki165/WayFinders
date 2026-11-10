import { useState } from "react";
import { useEditor, fixError, fixAllTorn as fixAll } from "../model/store";
import { wayName } from "../model/roads";
import type { GraphError, Severity } from "../model/validate";
import { locale, tr } from "../i18n";

const TITLE: Record<GraphError["type"], string> = {
  get torn() { return tr("Разорванный перекресток"); },
  get glued() { return tr("Пересечение без узла"); },
  get isolated() { return tr("Изолированный участок"); },
  get trap() { return tr("Ловушка по направлениям"); },
  get attr() { return tr("Не заполнены атрибуты"); },
  get bridge() { return tr("Мост без уровня"); },
  get building() { return tr("Дорога сквозь здание"); },
  get long() { return tr("Длинный участок без перекрестков"); },
};
const FIX: Partial<Record<GraphError["type"], string>> = { get torn() { return tr("Соединить"); }, get glued() { return tr("Добавить узел"); }, get isolated() { return tr("Удалить"); }, get attr() { return tr("Заполнить"); }, get bridge() { return tr("Поднять мост"); }, get building() { return tr("Мост над зданием"); } };
// длина: до 1 км в метрах, дальше в километрах
const km = (m: number) => (m < 1000 ? tr("{0} м", Math.round(m)) : tr("{0} км", (m / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 })));
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
      case "torn": return tr("«{0}» обрывается в {1} м от «{2}», но не соединена с ней. Машины не смогут здесь проехать.", nm(e.ways[0]), e.dist!.toFixed(1), nm(e.ways[1]));
      case "glued": return tr("«{0}» и «{1}» пересекаются на одном уровне без общего узла: это перекресток или мост.", nm(e.ways[0]), nm(e.ways[1]));
      case "isolated": return e.edge ? tr("{0} узлов не связаны с сетью: кусок обрезан краем карты. Обычно его оставляют.", e.count) : tr("{0} узлов не связаны с остальной сетью: машины туда не попадут.", e.count);
      case "trap": return tr("{0} узлов, {1} дорог: въехать можно, а выехать нельзя или наоборот. Проверьте направления движения. MatSim выкинет этот кусок.", e.count, e.ways.length);
      case "attr": return tr("«{0}»: не задано: {1}. Симуляторы подставят значения по умолчанию.", nm(e.ways[0]), e.miss!.map((k) => (k === "lanes" ? tr("число полос") : k === "maxspeed" ? tr("скорость") : k)).join(tr(" и ")));
      case "bridge": return tr("«{0}» отмечена мостом без уровня: может склеиться с дорогой под ней.", nm(e.ways[0]));
      case "long": return tr("«{0}»: {1} без перекрестков (для этого класса до {2}). Дорогу лучше соединить с соседними. Это предупреждение, оставить можно.", nm(e.ways[0]), km(e.len!), km(e.limit!));
      case "building": return tr("«{0}» проходит сквозь здание: в Webots машины поедут через стену. Перенесите дорогу, сделайте мост или отметьте проезд под домом (арку).", nm(e.ways[0]));
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
    st.toast(tr("Соединено разрывов: {0}. Отменить все сразу: Ctrl+Z", n));
  };
  const pct = check.nodes ? (check.sccMain / check.nodes) * 100 : 100;

  return (
    <div className="pane">
      <div className={"status " + (count.danger ? "bad" : "good")}>
        {count.danger ? tr("Критичных ошибок: {0}. Их стоит исправить до отправки.", count.danger) : tr("Критичных ошибок нет. Граф можно сохранять.")}
      </div>
      <div className="sumcards">
        {(["danger", "warn", "info"] as const).map((s) => (
          <button key={s} className={filter === s ? "on" : ""} onClick={() => setFilter(filter === s ? "all" : s)}>
            <b className={"c-" + s}>{count[s]}</b>
            <small>{s === "danger" ? tr("Критичные") : s === "warn" ? tr("Предупреждения") : tr("Подсказки")}</small>
          </button>
        ))}
      </div>
      <p className="hint">{tr("Связность по направлениям:")}{" "}{pct.toFixed(1)}{tr("% узлов в главной сильной компоненте. Компонент связности:")}{" "}{check.components}.</p>
      <div className="chips">
        <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>{tr("Все")}</button>
        {count.danger > 0 && <button onClick={fixAllTorn}>{tr("Соединить все разрывы")}</button>}
      </div>
      {list.map((e) => (
        <div key={e.key} className={"err" + (cur === e.key ? " cur" : "")}>
          <span className={"bar sev-" + e.sev} />
          <div>
            <b>{TITLE[e.type]}</b>
            <p>{text(e)}</p>
            <div className="chips">
              <button onClick={() => show(e)}>{tr("Показать")}</button>
              {FIX[e.type] && !(e.type === "isolated" && e.edge) && <button onClick={() => { fixError(e); st.toast(tr("Исправлено: ") + TITLE[e.type].toLowerCase()); }}>{FIX[e.type]}</button>}
              <button onClick={() => st.ignore(e.key)}>{e.type === "isolated" && e.edge ? tr("Оставить как есть") : tr("Пропустить")}</button>
            </div>
          </div>
        </div>
      ))}
      {!list.length && <p className="hint">{tr("В этой группе ошибок нет.")}</p>}
    </div>
  );
}
