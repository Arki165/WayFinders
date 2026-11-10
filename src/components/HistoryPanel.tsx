import { useEditor } from "../model/store";
import { toCsv, saveCsv } from "../model/exporting";

export default function HistoryPanel() {
  const log = useEditor((s) => s.log);
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const fileName = useEditor((s) => s.fileName);

  const exportLog = () => {
    const rows = [...log].reverse().map((l, i) => [i + 1, l.time.toLocaleString("ru-RU"), l.label]);
    saveCsv(fileName.replace(/\.osm$/i, "") + "_history.csv", toCsv(["№", "Время", "Действие"], rows));
  };

  return (
    <div className="pane">
      <div className="chips">
        <button onClick={undo} disabled={!past.length}>↶ Отменить</button>
        <button onClick={redo} disabled={!future.length}>↷ Повторить</button>
        <button onClick={exportLog} disabled={!log.length}>Скачать CSV</button>
      </div>
      <p className="hint">Действий в истории: {past.length}. Можно отменить: Ctrl+Z, повторить: Ctrl+Y.</p>
      <div className="hist">
        {log.length ? log.slice(0, 200).map((l, i) => (
          <div key={i}><span>{l.label}</span><time>{l.time.toLocaleTimeString("ru-RU")}</time></div>
        )) : <p className="hint">Правок пока нет. Каждое действие попадет сюда.</p>}
      </div>
    </div>
  );
}
