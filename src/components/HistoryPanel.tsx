import { useEditor } from "../model/store";
import { toCsv, saveCsv } from "../model/exporting";
import Icon from "./Icon";
import { locale, tr } from "../i18n";

export default function HistoryPanel() {
  const log = useEditor((s) => s.log);
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const fileName = useEditor((s) => s.fileName);

  const exportLog = () => {
    const rows = [...log].reverse().map((l, i) => [i + 1, l.time.toLocaleString(locale()), l.label]);
    saveCsv(fileName.replace(/\.osm$/i, "") + "_history.csv", toCsv(["№", tr("Время"), tr("Действие")], rows));
  };

  return (
    <div className="pane">
      <div className="chips">
        <button onClick={undo} disabled={!past.length}><Icon name="undo" size={15} />{tr("Отменить")}</button>
        <button onClick={redo} disabled={!future.length}><Icon name="redo" size={15} />{tr("Повторить")}</button>
        <button onClick={exportLog} disabled={!log.length}><Icon name="download" size={14} />CSV</button>
      </div>
      <p className="hint">{tr("Действий в истории:")}{" "}{past.length}{tr(". Можно отменить: Ctrl+Z, повторить: Ctrl+Y.")}</p>
      <div className="hist">
        {log.length ? log.slice(0, 200).map((l, i) => (
          <div key={i}><span>{l.label}</span><time>{l.time.toLocaleTimeString(locale())}</time></div>
        )) : <p className="hint">{tr("Правок пока нет. Каждое действие попадет сюда.")}</p>}
      </div>
    </div>
  );
}
