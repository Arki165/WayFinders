import { useEffect, useMemo, useState } from "react";
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
import StreetSearch from "./components/StreetSearch";
import Icon, { Logo, type IconName } from "./components/Icon";

// Инструменты слева, по группам: выбор | рисование | связи дорог | светофор | удаление. group - с него начинается новая группа
const TOOLS: { id: Tool; key: string; label: string; icon: IconName; group?: true }[] = [
  { id: "select", key: "V", label: "Выбор и перенос", icon: "select" },
  { id: "draw", key: "W", label: "Нарисовать дорогу", icon: "draw", group: true },
  { id: "node", key: "N", label: "Добавить узел на дорогу", icon: "node" },
  { id: "join", key: "J", label: "Соединить: узел с узлом или с дорогой", icon: "join", group: true },
  { id: "unjoin", key: "U", label: "Разъединить дороги в узле", icon: "unjoin" },
  { id: "split", key: "X", label: "Разрезать дорогу", icon: "split" },
  { id: "signal", key: "T", label: "Светофор", icon: "signal", group: true },
  { id: "delete", key: "D", label: "Удалить", icon: "trash", group: true },
];

// Сохраненная раскладка окна (какие панели открыты, их размеры, подложка)
type Layout = { side?: "props" | "errors" | "history" | null; bottom?: "calc" | "compare" | "formulas" | null; sideWidth?: number; bottomHeight?: number; basemap?: Basemap; buildings?: boolean };
function loadLayout(): Layout {
  try { return JSON.parse(localStorage.getItem("layout") ?? "{}"); } catch { return {}; }
}

// Горячие клавиши для окна-подсказки: клавиши через пробел, затем что делают
const HOTKEYS: [string, string][] = [
  ["V", "Выбор, перетаскивание узлов"], ["W", "Нарисовать дорогу"], ["N", "Добавить узел"], ["J", "Соединить"], ["U", "Разъединить"],
  ["T", "Светофор"], ["X", "Разрезать дорогу"], ["D", "Удалить кликом"], ["R", "Развернуть направление"], ["Del", "Удалить выделенное"],
  ["Shift Клик", "Добавить к выделению"], ["Enter", "Закончить дорогу"], ["Esc", "Отмена, снять выделение"],
  ["3", "2D или 3D"], ["H", "Загрузка Z на карте"], ["Ctrl Z", "Отменить"], ["Ctrl Y", "Повторить"],
  ["Ctrl S", "Сохранить"], ["Ctrl O", "Открыть файл"], ["Ctrl F", "Поиск улицы"], ["?", "Этот список"],
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
  // раскладка окна запоминается между запусками: панели остаются такими, какими их оставили
  const [saved] = useState(loadLayout);
  const [side, setSide] = useState<"props" | "errors" | "history" | null>(saved.side === undefined ? "props" : saved.side);
  const [bottom, setBottom] = useState<"calc" | "compare" | "formulas" | null>(saved.bottom === undefined ? "calc" : saved.bottom);
  // размеры панелей в пикселях, меняются перетаскиванием края
  const [sideWidth, setSideWidth] = useState(Math.min(saved.sideWidth ?? 360, Math.round(window.innerWidth * 0.6)));
  const [bottomHeight, setBottomHeight] = useState(Math.min(saved.bottomHeight ?? 320, window.innerHeight - 250));
  const [basemap, setBasemap] = useState<Basemap>(saved.basemap ?? "map");
  const [view3d, setView3d] = useState(false);
  const [heat, setHeat] = useState(false);
  const [buildings, setBuildings] = useState(saved.buildings ?? true);
  const [changesOn, setChangesOn] = useState(false);
  const [tpl, setTpl] = useState("secondary");
  // магнит при рисовании, выбор запоминается
  const [magnet, setMagnet] = useState(() => { try { return localStorage.getItem("magnet") !== "off"; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem("magnet", magnet ? "on" : "off"); } catch { /* хранилище недоступно */ } }, [magnet]);
  const [dialog, setDialog] = useState<"save" | "import" | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  // тема запоминается между запусками
  const [theme, setTheme] = useState(localStorage.getItem("theme") === "dark" ? "dark" : "light");

  useEffect(() => {
    try { localStorage.setItem("layout", JSON.stringify({ side, bottom, sideWidth, bottomHeight, basemap, buildings })); } catch { /* хранилище недоступно */ }
  }, [side, bottom, sideWidth, bottomHeight, basemap, buildings]);

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
      if (k === "?" || k === "/") return setKeysOpen((v) => !v);
      if (k === "escape") { setKeysOpen(false); st.getState().select(null); st.getState().setHighlight([]); return setTool("select"); }
      if (k === "3") return setView3d((v) => !v);
      if (k === "h" || k === "р") return setHeat((v) => !v);
      const map: Record<string, Tool> = { v: "select", м: "select", w: "draw", ц: "draw", n: "node", т: "node", j: "join", о: "join", u: "unjoin", г: "unjoin", t: "signal", е: "signal", x: "split", ч: "split", d: "delete", в: "delete" };
      if (map[k]) setTool(map[k]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const crit = check?.errors.filter((e) => e.sev === "danger").length ?? 0;
  // число светофоров для строки состояния: считаем только после правки, а не на каждую перерисовку
  const signals = useMemo(() => {
    if (!data) return 0;
    const on = drivableNodeSet(data);
    let n = 0;
    for (const node of data.nodes.values()) if (isRoadSignal(node, on)) n++;
    return n;
  }, [data, version]); // eslint-disable-line react-hooks/exhaustive-deps
  void version;


  return (
    <div className="app">
      <header className="toolbar">
        {/* верхняя панель: логотип с именем файла, группы «файл», «правка», поиск, «вид» */}
        <div className="brand" title="Версия программы">
          <Logo size={28} />
          <span className="brand-text">
            <b>Wayfinder <small>v{VERSION}</small></b>
            <span className="file">{fileName || "Файл не открыт"}{past.length > 0 && <i className="dirty" title="Есть несохраненные правки" />}</span>
          </span>
        </div>
        <div className="tb-group">
          <button onClick={openFile} title="Открыть .osm (Ctrl+O)"><Icon name="folder" /><span className="lbl-1">Открыть</span></button>
          <button onClick={addMap} disabled={!data || loading} title="Добавить карту: присоединить еще один .osm к открытой карте (соседний район или другой город). Дороги на стыке сшиваются"><Icon name="addMap" /><span className="lbl-1">Карта</span></button>
          <button onClick={() => setDialog("import")} title="Загрузить район или город из OpenStreetMap"><Icon name="globe" /><span className="lbl-1">Из OSM</span></button>
          <button className="tb-save" onClick={() => setDialog("save")} disabled={!data} title="Сохранить .osm (Ctrl+S)"><Icon name="save" />Сохранить</button>
        </div>
        <div className="tb-group">
          <button className="tb-icon" onClick={() => st.getState().undo()} disabled={!past.length} title="Отменить (Ctrl+Z)"><Icon name="undo" /></button>
          <button className="tb-icon" onClick={() => st.getState().redo()} disabled={!data} title="Повторить (Ctrl+Y)"><Icon name="redo" /></button>
        </div>
        <StreetSearch onPick={() => setSide("props")} />
        <span className="grow" />
        <div className="tb-group">
          <button className={!view3d ? "on" : ""} onClick={() => setView3d(false)} title="Вид сверху">2D</button>
          <button className={view3d ? "on" : ""} onClick={() => setView3d(true)} title="Наклонный вид с объемными зданиями (3)">3D</button>
          <select value={basemap} onChange={(e) => setBasemap(e.target.value as Basemap)} title="Подложка карты">
            <option value="map">Схема</option>
            <option value="satellite">Спутник</option>
          </select>
        </div>
        <div className="tb-group">
          <button className={heat ? "on" : ""} onClick={() => setHeat(!heat)} title="Тепловая карта загрузки (H)"><Icon name="gauge" /><span className="lbl-2">Загрузка Z</span></button>
          <button className={buildings ? "on" : ""} onClick={() => setBuildings(!buildings)} title="Показать здания"><Icon name="building" /><span className="lbl-2">Здания</span></button>
          <button className={changesOn ? "on" : ""} onClick={() => setChangesOn(!changesOn)} title="Показать на карте новые, измененные и удаленные дороги"><Icon name="diff" /><span className="lbl-2">Правки</span></button>
        </div>
        <button className="tb-icon tb-theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title={theme === "dark" ? "Светлая тема" : "Темная тема"}><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
      </header>

      <div className="work" style={{ gridTemplateColumns: `54px minmax(0, 1fr) ${!data ? "" : side ? sideWidth + "px" : "36px"}` }}>
        <nav className="tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={"tool" + (tool === t.id ? " on" : "") + (t.group ? " tool-group" : "")} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`} disabled={!data}>
              <Icon name={t.icon} size={20} /><kbd>{t.key}</kbd>
            </button>
          ))}
        </nav>

        <main className="center">
          <MapView basemap={basemap} view3d={view3d} heat={heat} showBuildings={buildings} showChanges={changesOn} drawTemplate={tpl} magnet={magnet} dark={theme === "dark"}>
            {tool === "draw" && (
              <div className="optbar">Шаблон новой дороги:
                <select value={tpl} onChange={(e) => setTpl(e.target.value)}>{Object.entries(TEMPLATES).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}</select>
                <label className="check" title="Точка прилипает к ближнему узлу или встает на линию дороги общим узлом"><input type="checkbox" checked={magnet} onChange={(e) => setMagnet(e.target.checked)} />Магнит</label>
              </div>
            )}
          </MapView>
          {!data && (
            <div className="start">
              <Logo size={72} />
              <h1>Wayfinder</h1>
              <p>Редактор графа улично-дорожной сети. Открывает .osm, правит дороги, полосы, направления, светофоры и мосты, находит ошибки и сохраняет .osm для MatSim, SUMO и Webots.</p>
              <div className="start-btns">
                <button className="primary" onClick={openFile} disabled={loading}><Icon name="folder" />Открыть файл .osm</button>
                <button onClick={openExample} disabled={loading}><Icon name="addMap" />Открыть пример: Иркутск, example.osm</button>
                <button onClick={() => setDialog("import")} disabled={loading}><Icon name="globe" />Загрузить район из OpenStreetMap</button>
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
                <button className="hide" onClick={() => setBottom(null)} title="Скрыть панель и отдать место карте"><span className="lbl">Скрыть</span><Icon name="chevronDown" size={14} /></button>
              </div>
              {bottom === "calc" && <CalcPanel />}
              {bottom === "compare" && <ComparePanel />}
              {bottom === "formulas" && <FormulasPanel />}
            </section>
          )}
          {!bottom && data && (
            <div className="bottom-rail" title="Открыть нижнюю панель">
              <button onClick={() => setBottom("calc")}><Icon name="chevronUp" size={14} />Расчеты и графики</button>
              <button onClick={() => setBottom("compare")}><Icon name="chevronUp" size={14} />Сравнение с исходным</button>
              <button onClick={() => setBottom("formulas")}><Icon name="chevronUp" size={14} />Формулы</button>
            </div>
          )}
        </main>

        {!data ? null : side ? (
          <aside className="side">
            <Resizer dir="x" value={sideWidth} min={280} max={Math.round(window.innerWidth * 0.6)} onChange={setSideWidth} />
            <div className="tabs">
              <button className={side === "props" ? "on" : ""} onClick={() => setSide("props")}>Свойства</button>
              <button className={side === "errors" ? "on" : ""} onClick={() => setSide("errors")}>Ошибки {check && <span className={"badge" + (crit ? "" : " ok")}>{check.errors.length}</span>}</button>
              <button className={side === "history" ? "on" : ""} onClick={() => setSide("history")}>История</button>
              <span className="grow" />
              <button className="hide" onClick={() => setSide(null)} title="Скрыть панель и отдать место карте"><span className="lbl">Скрыть</span><Icon name="chevronRight" size={14} /></button>
            </div>
            {side === "props" && <PropsPanel />}
            {side === "errors" && <ErrorsPanel />}
            {side === "history" && <HistoryPanel />}
          </aside>
        ) : (
          <aside className="rail" title="Открыть правую панель">
            <button onClick={() => setSide("props")}><Icon name="chevronLeft" size={14} className="arrow" />Свойства</button>
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
            <button className={"keys-btn" + (keysOpen ? " on" : "")} onClick={() => setKeysOpen(!keysOpen)} title="Список горячих клавиш (?)"><kbd>?</kbd>Горячие клавиши</button>
          </>
        ) : <span>Откройте файл .osm, пример или загрузите район из OpenStreetMap</span>}
      </footer>

      {keysOpen && (
        // список всех клавиш: открывается кнопкой справа внизу или клавишей «?», закрывается кликом мимо или Esc
        <div className="keys-back" onClick={() => setKeysOpen(false)}>
          <div className="keys-pop" onClick={(e) => e.stopPropagation()}>
            <h3>Горячие клавиши</h3>
            <dl>
              {HOTKEYS.map(([k, t]) => <div key={k}><dt>{k.split(" ").map((x) => <kbd key={x}>{x}</kbd>)}</dt><dd>{t}</dd></div>)}
            </dl>
          </div>
        </div>
      )}

      {toastVisible && message && <div className="toast">{message.text}</div>}
      {dialog === "save" && data && <SaveDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} getBounds={getMapBounds} />}
    </div>
  );
}
