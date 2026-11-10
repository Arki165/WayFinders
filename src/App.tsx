import { useEffect, useState } from "react";
import MapView, { getMapBounds, type Basemap } from "./components/MapView";
import PropsPanel from "./components/PropsPanel";
import ErrorsPanel from "./components/ErrorsPanel";
import HistoryPanel from "./components/HistoryPanel";
import CalcPanel from "./components/CalcPanel";
import ComparePanel from "./components/ComparePanel";
import FormulasPanel from "./components/FormulasPanel";
import Resizer from "./components/Resizer";
import { ImportDialog, SaveDialog } from "./components/Dialogs";
import { useEditor, deleteNode, deleteWay, deleteWays, reverseWay, mergeMap, type Tool } from "./model/store";
import { parseOsm } from "./osm/parse";
import { TEMPLATES } from "./model/templates";
import { drivableNodeSet, isRoadSignal } from "./model/roads";
import { VERSION } from "./version";

const TOOLS: { id: Tool; key: string; label: string; icon: string }[] = [
  { id: "select", key: "V", label: "Выбор и перенос", icon: "↖" },
  { id: "draw", key: "W", label: "Нарисовать дорогу", icon: "✎" },
  { id: "node", key: "N", label: "Добавить узел на дорогу", icon: "⊕" },
  { id: "join", key: "J", label: "Соединить: узел с узлом или с дорогой", icon: "🔗" },
  { id: "unjoin", key: "U", label: "Разъединить дороги в узле", icon: "⛓" },
  { id: "signal", key: "T", label: "Светофор", icon: "🚦" },
  { id: "split", key: "X", label: "Разрезать дорогу", icon: "✂" },
  { id: "delete", key: "D", label: "Удалить", icon: "🗑" },
];

export default function App() {
  const data = useEditor((s) => s.data);
  const fileName = useEditor((s) => s.fileName);
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const check = useEditor((s) => s.check);
  const past = useEditor((s) => s.past);
  const message = useEditor((s) => s.message);
  const version = useEditor((s) => s.version);
  const st = useEditor;

  // null - панель скрыта, вместо нее узкая полоска с вкладками
  const [side, setSide] = useState<"props" | "errors" | "history" | null>("props");
  const [bottom, setBottom] = useState<"calc" | "compare" | "formulas" | null>("calc");
  // размеры панелей в пикселях, меняются перетаскиванием края
  const [sideWidth, setSideWidth] = useState(360);
  const [bottomHeight, setBottomHeight] = useState(320);
  const [basemap, setBasemap] = useState<Basemap>("map");
  const [view3d, setView3d] = useState(false);
  const [heat, setHeat] = useState(false);
  const [buildings, setBuildings] = useState(true);
  const [changesOn, setChangesOn] = useState(false);
  const [tpl, setTpl] = useState("secondary");
  const [dialog, setDialog] = useState<"save" | "import" | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  // тема запоминается между запусками
  const [theme, setTheme] = useState(localStorage.getItem("theme") === "dark" ? "dark" : "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!message) return;
    setToastVisible(true);
    const t = setTimeout(() => setToastVisible(false), 3200);
    return () => clearTimeout(t);
  }, [message]);

  async function openFile() {
    if (window.api) {
      const f = await window.api.openOsm();
      if (!f) return;
      loadText(f.text, f.name, f.path);
    } else {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".osm,.xml";
      inp.onchange = async () => { const f = inp.files?.[0]; if (f) loadText(await f.text(), f.name, null); };
      inp.click();
    }
  }
  function loadText(text: string, name: string, path: string | null) {
    setLoading(true);
    setTimeout(() => {
      try {
        const t0 = performance.now();
        const d = parseOsm(text);
        st.getState().load(d, name, path);
        st.getState().toast(`Открыт ${name}: ${d.ways.size} линий, ${d.nodes.size} узлов за ${((performance.now() - t0) / 1000).toFixed(1)} с`);
      } catch (e) {
        st.getState().toast("Не удалось открыть файл: " + (e instanceof Error ? e.message : e));
      } finally {
        setLoading(false);
      }
    }, 30);
  }
  // Присоединить еще одну карту (.osm) к открытой: соседний район, другой город
  async function addMap() {
    let f: { text: string; name: string } | null = null;
    if (window.api) f = await window.api.openOsm();
    else f = await new Promise((ok) => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".osm,.xml";
      inp.onchange = async () => { const x = inp.files?.[0]; ok(x ? { text: await x.text(), name: x.name } : null); };
      inp.click();
    });
    if (!f) return;
    const { text, name } = f;
    setLoading(true);
    setTimeout(() => {
      try {
        const r = mergeMap(parseOsm(text), name);
        if (r) st.getState().toast(`Карта ${name} присоединена: ${r.ways} линий, ${r.nodes} узлов. На стыке сшито дорог: ${r.stitched}`);
      } catch (e) {
        st.getState().toast("Не удалось присоединить файл: " + (e instanceof Error ? e.message : e));
      } finally {
        setLoading(false);
      }
    }, 30);
  }
  async function openExample() {
    setLoading(true);
    try {
      let text: string;
      if (window.api) text = await window.api.readExample();
      else {
        const res = await fetch("./example.osm");
        if (!res.ok) throw new Error(`файл не найден (${res.status})`);
        text = await res.text();
      }
      loadText(text, "example.osm", null);
    } catch (e) {
      setLoading(false);
      st.getState().toast("Не удалось открыть пример: " + (e instanceof Error ? e.message : e) + ". Запустите программу через npm start.");
    }
  }

  // горячие клавиши
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && (k === "o" || k === "щ")) { e.preventDefault(); return openFile(); }
      if (!st.getState().data) return;
      if (mod && (k === "s" || k === "ы")) { e.preventDefault(); return setDialog("save"); }
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (mod && (k === "z" || k === "я")) { e.preventDefault(); return e.shiftKey ? st.getState().redo() : st.getState().undo(); }
      if (mod && (k === "y" || k === "н")) { e.preventDefault(); return st.getState().redo(); }
      if (mod || e.altKey) return;
      const sel = st.getState().selection;
      if ((k === "delete" || k === "backspace") && sel) { e.preventDefault(); return sel.kind === "way" ? deleteWay(sel.id) : sel.kind === "node" ? deleteNode(sel.id) : deleteWays(sel.ids); }
      if ((k === "r" || k === "к") && sel?.kind === "way") return reverseWay(sel.id);
      if (k === "escape") { st.getState().select(null); st.getState().setHighlight([]); return setTool("select"); }
      if (k === "3") return setView3d((v) => !v);
      if (k === "h" || k === "р") return setHeat((v) => !v);
      const map: Record<string, Tool> = { v: "select", м: "select", w: "draw", ц: "draw", n: "node", т: "node", j: "join", о: "join", u: "unjoin", г: "unjoin", t: "signal", е: "signal", x: "split", ч: "split", d: "delete", в: "delete" };
      if (map[k]) setTool(map[k]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const crit = check?.errors.filter((e) => e.sev === "danger").length ?? 0;
  const names = data ? [...new Set([...data.ways.values()].map((w) => w.tags.highway && w.tags.name).filter(Boolean) as string[])].sort() : [];
  const signals = data ? (() => { const on = drivableNodeSet(data); return [...data.nodes.values()].filter((n) => isRoadSignal(n, on)).length; })() : 0;
  void version;

  function search(q: string) {
    if (!data || !q.trim()) return;
    const ws = [...data.ways.values()].filter((w) => w.tags.highway && (w.tags.name ?? "").toLowerCase().includes(q.trim().toLowerCase()));
    if (!ws.length) return st.getState().toast("Улица не найдена");
    st.getState().setHighlight(ws.map((w) => w.id));
    st.getState().select({ kind: "way", id: ws[0].id });
    const n = data.nodes.get(ws[0].nodeIds[Math.floor(ws[0].nodeIds.length / 2)])!;
    st.getState().flyTo(n.lat, n.lon, 16.5);
    setSide("props");
  }

  return (
    <div className="app">
      <header className="toolbar">
        <span className="logo" title="Версия программы">WayFinders <small className="ver">v{VERSION}</small></span>
        <button onClick={openFile} title="Открыть .osm (Ctrl+O)">Открыть</button>
        <button onClick={addMap} disabled={!data || loading} title="Присоединить еще один .osm к открытой карте: соседний район или другой город. Дороги на стыке сшиваются">+ Добавить карту</button>
        <button onClick={() => setDialog("import")}>Загрузить из OSM</button>
        <button onClick={() => setDialog("save")} disabled={!data} title="Сохранить (Ctrl+S)">Сохранить .osm</button>
        <span className="sep" />
        <button onClick={() => st.getState().undo()} disabled={!past.length} title="Отменить (Ctrl+Z)">↶</button>
        <button onClick={() => st.getState().redo()} disabled={!data} title="Повторить (Ctrl+Y)">↷</button>
        <span className="sep" />
        <input className="search" list="streets" placeholder="Найти улицу" disabled={!data} onKeyDown={(e) => e.key === "Enter" && search((e.target as HTMLInputElement).value)} onChange={(e) => names.includes(e.target.value) && search(e.target.value)} />
        <datalist id="streets">{names.map((n) => <option key={n} value={n} />)}</datalist>
        <span className="grow" />
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Светлая или темная тема">{theme === "dark" ? "☀ Светлая" : "☾ Темная"}</button>
        <div className="seg"><button className={!view3d ? "on" : ""} onClick={() => setView3d(false)}>2D</button><button className={view3d ? "on" : ""} onClick={() => setView3d(true)}>3D</button></div>
        <select value={basemap} onChange={(e) => setBasemap(e.target.value as Basemap)}>
          <option value="map">Подложка: схема</option>
          <option value="satellite">Подложка: спутник</option>
        </select>
        <button className={heat ? "on" : ""} onClick={() => setHeat(!heat)} title="Тепловая карта загрузки (H)">Загрузка Z</button>
        <button className={buildings ? "on" : ""} onClick={() => setBuildings(!buildings)}>Здания</button>
        <button className={changesOn ? "on" : ""} onClick={() => setChangesOn(!changesOn)} title="Показать на карте новые, измененные и удаленные дороги">Правки</button>
        <span className="file">{fileName || "файл не открыт"}{past.length > 0 && <i className="dirty" title="Есть несохраненные правки" />}</span>
      </header>

      <div className="work" style={{ gridTemplateColumns: `54px minmax(0, 1fr) ${side ? sideWidth + "px" : "36px"}` }}>
        <nav className="tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={"tool" + (tool === t.id ? " on" : "")} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`} disabled={!data}>
              <span>{t.icon}</span><kbd>{t.key}</kbd>
            </button>
          ))}
        </nav>

        <main className="center">
          <MapView basemap={basemap} view3d={view3d} heat={heat} showBuildings={buildings} showChanges={changesOn} drawTemplate={tpl} dark={theme === "dark"} />
          {tool === "draw" && (
            <div className="optbar">Шаблон новой дороги:
              <select value={tpl} onChange={(e) => setTpl(e.target.value)}>{Object.entries(TEMPLATES).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}</select>
            </div>
          )}
          {!data && (
            <div className="start">
              <h1>WayFinders</h1>
              <p>Редактор графа улично-дорожной сети. Открывает .osm, правит дороги, полосы, направления, светофоры и мосты, находит ошибки и сохраняет .osm для MatSim, SUMO и Webots.</p>
              <div className="start-btns">
                <button className="primary" onClick={openFile} disabled={loading}>Открыть файл .osm</button>
                <button onClick={openExample} disabled={loading}>Открыть пример: Иркутск, example.osm</button>
                <button onClick={() => setDialog("import")} disabled={loading}>Загрузить район из OpenStreetMap</button>
              </div>
              {loading && <p className="hint">Загрузка...</p>}
            </div>
          )}
          {bottom && data && (
            <section className="bottom" style={{ height: bottomHeight }}>
              <Resizer dir="y" value={bottomHeight} min={150} max={window.innerHeight - 250} onChange={setBottomHeight} />
              <div className="tabs">
                <button className={bottom === "calc" ? "on" : ""} onClick={() => setBottom("calc")}>Расчеты и графики</button>
                <button className={bottom === "compare" ? "on" : ""} onClick={() => setBottom("compare")}>Сравнение с исходным</button>
                <button className={bottom === "formulas" ? "on" : ""} onClick={() => setBottom("formulas")}>Формулы</button>
                <span className="grow" />
                <button className="hide" onClick={() => setBottom(null)} title="Скрыть панель и отдать место карте">Скрыть ▾</button>
              </div>
              {bottom === "calc" && <CalcPanel />}
              {bottom === "compare" && <ComparePanel />}
              {bottom === "formulas" && <FormulasPanel />}
            </section>
          )}
          {!bottom && data && (
            <div className="bottom-rail" title="Открыть нижнюю панель">
              <button onClick={() => setBottom("calc")}>▴ Расчеты и графики</button>
              <button onClick={() => setBottom("compare")}>▴ Сравнение с исходным</button>
              <button onClick={() => setBottom("formulas")}>▴ Формулы</button>
            </div>
          )}
        </main>

        {side ? (
          <aside className="side">
            <Resizer dir="x" value={sideWidth} min={280} max={Math.round(window.innerWidth * 0.6)} onChange={setSideWidth} />
            <div className="tabs">
              <button className={side === "props" ? "on" : ""} onClick={() => setSide("props")}>Свойства</button>
              <button className={side === "errors" ? "on" : ""} onClick={() => setSide("errors")}>Ошибки {check && <span className={"badge" + (crit ? "" : " ok")}>{check.errors.length}</span>}</button>
              <button className={side === "history" ? "on" : ""} onClick={() => setSide("history")}>История</button>
              <span className="grow" />
              <button className="hide" onClick={() => setSide(null)} title="Скрыть панель и отдать место карте">Скрыть ▸</button>
            </div>
            {side === "props" && <PropsPanel />}
            {side === "errors" && <ErrorsPanel />}
            {side === "history" && <HistoryPanel />}
          </aside>
        ) : (
          <aside className="rail" title="Открыть правую панель">
            <button onClick={() => setSide("props")}><span className="arrow">◂</span>Свойства</button>
            <button onClick={() => setSide("errors")}>Ошибки {check && <span className={"badge" + (crit ? "" : " ok")}>{check.errors.length}</span>}</button>
            <button onClick={() => setSide("history")}>История</button>
          </aside>
        )}
      </div>

      <footer className="statusbar">
        {data ? (
          <>
            <span>Дорог: {[...data.ways.values()].filter((w) => w.tags.highway).length}</span>
            <span>Узлов в графе: {check?.nodes ?? 0}</span>
            <span>Светофоров на дорогах: {signals}</span>
            <span className={crit ? "c-danger" : "c-ok"}>Критичных ошибок: {crit}</span>
            <span>Правок: {past.length}</span>
            <span className="grow" />
            <span>V выбор · W дорога · N узел · J соединить · U разъединить · T светофор · X разрезать · D удалить · R направление · Del удалить выделенное · 3 2D/3D · H загрузка · Ctrl+Z отмена</span>
          </>
        ) : <span>Откройте файл .osm, пример или загрузите район из OpenStreetMap</span>}
      </footer>

      {toastVisible && message && <div className="toast">{message.text}</div>}
      {dialog === "save" && data && <SaveDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} getBounds={getMapBounds} />}
    </div>
  );
}
