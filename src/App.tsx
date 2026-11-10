import { useEffect, useMemo, useState } from "react";
import MapView, { getMapBounds, type Basemap } from "./components/MapView";
import PropsPanel from "./components/PropsPanel";
import ErrorsPanel from "./components/ErrorsPanel";
import HistoryPanel from "./components/HistoryPanel";
import CalcPanel from "./components/CalcPanel";
import ComparePanel from "./components/ComparePanel";
import FormulasPanel from "./components/FormulasPanel";
import Resizer from "./components/Resizer";
import RoutesPanel from "./components/RoutesPanel";
import AppMenu from "./components/AppMenu";
import GuideDialog from "./components/GuideDialog";
import { ImportDialog, SaveDialog } from "./components/Dialogs";
import { useEditor, deleteNode, deleteWay, deleteWays, reverseWay, mergeMap, isDirty, okToReplace, type Tool } from "./model/store";
import { parseOsm } from "./osm/parse";
import { TEMPLATES } from "./model/templates";
import { drivableNodeSet, isRoadSignal } from "./model/roads";
import { VERSION } from "./version";
import StreetSearch from "./components/StreetSearch";
import Icon, { Logo, type IconName } from "./components/Icon";
import { tr, useLang } from "./i18n";

// Инструменты слева, по группам: выбор | рисование | связи дорог | светофор | удаление. group - с него начинается новая группа
const TOOLS: { id: Tool; key: string; label: string; icon: IconName; group?: true }[] = [
  { id: "select", key: "V", get label() { return tr("Выбор и перенос"); }, icon: "select" },
  { id: "draw", key: "W", get label() { return tr("Нарисовать дорогу"); }, icon: "draw", group: true },
  { id: "node", key: "N", get label() { return tr("Добавить узел на дорогу"); }, icon: "node" },
  { id: "join", key: "J", get label() { return tr("Соединить: узел с узлом или с дорогой"); }, icon: "join", group: true },
  { id: "unjoin", key: "U", get label() { return tr("Разъединить дороги в узле"); }, icon: "unjoin" },
  { id: "split", key: "X", get label() { return tr("Разрезать дорогу"); }, icon: "split" },
  { id: "signal", key: "T", get label() { return tr("Светофор"); }, icon: "signal", group: true },
  { id: "delete", key: "D", get label() { return tr("Удалить"); }, icon: "trash", group: true },
];

// Сохраненная раскладка окна (какие панели открыты, их размеры, подложка)
type Layout = { side?: "props" | "errors" | "history" | "routes" | null; bottom?: "calc" | "compare" | "formulas" | null; sideWidth?: number; bottomHeight?: number; basemap?: Basemap; buildings?: boolean };
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
  const savedCmd = useEditor((s) => s.saved);
  const dirty = !!data && (past[past.length - 1] ?? null) !== savedCmd;
  // главный процесс спрашивает это перед закрытием окна
  useEffect(() => { window.wfDirty = isDirty; return () => { delete window.wfDirty; }; }, []);
  const future = useEditor((s) => s.future);
  const message = useEditor((s) => s.message);
  const version = useEditor((s) => s.version);
  const st = useEditor;

  // null - панель скрыта, вместо нее узкая полоска с вкладками
  // раскладка окна запоминается между запусками: панели остаются такими, какими их оставили
  const [saved] = useState(loadLayout);
  const [side, setSide] = useState<"props" | "errors" | "history" | "routes" | null>(saved.side === undefined ? "props" : saved.side);
  const [bottom, setBottom] = useState<"calc" | "compare" | "formulas" | null>(saved.bottom === undefined ? "calc" : saved.bottom);
  // размеры панелей в пикселях, меняются перетаскиванием края
  // размеры панелей не меньше рабочего минимума: если окно открылось свернутым (ширина 0),
  // раньше запоминалась панель шириной 0 и пропадала насовсем
  const [sideWidth, setSideWidth] = useState(Math.max(300, Math.min(saved.sideWidth ?? 360, Math.round(window.innerWidth * 0.6))));
  const [bottomHeight, setBottomHeight] = useState(Math.max(150, Math.min(saved.bottomHeight ?? 320, window.innerHeight - 250)));
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
  const [guideOpen, setGuideOpen] = useState(false);
  // язык: при смене все окно перерисовывается с новыми текстами
  useLang((s) => s.lang);
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
    if (!okToReplace()) return;
    if (window.api) {
      let f: Awaited<ReturnType<NonNullable<typeof window.api>["openOsm"]>>;
      // файл может не прочитаться: нет доступа, слишком большой
      try { f = await window.api.openOsm(); } catch (e) { return st.getState().toast(tr("Не удалось открыть файл: ") + (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, "") : e)); }
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
        st.getState().toast(tr("Открыт {0}: {1} линий, {2} узлов за {3} с", name, d.ways.size, d.nodes.size, ((performance.now() - t0) / 1000).toFixed(1)));
      } catch (e) {
        st.getState().toast(tr("Не удалось открыть файл: ") + (e instanceof Error ? e.message : e));
      } finally {
        setLoading(false);
      }
    }, 30);
  }
  // Присоединить еще одну карту (.osm) к открытой: соседний район, другой город
  async function addMap() {
    let f: { text: string; name: string } | null = null;
    if (window.api) {
      try { f = await window.api.openOsm(); } catch (e) { return st.getState().toast(tr("Не удалось присоединить файл: ") + (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, "") : e)); }
    } else f = await new Promise((ok) => {
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
        if (r) st.getState().toast(tr("Карта {0} присоединена: {1} линий, {2} узлов. На стыке сшито дорог: {3}", name, r.ways, r.nodes, r.stitched));
      } catch (e) {
        st.getState().toast(tr("Не удалось присоединить файл: ") + (e instanceof Error ? e.message : e));
      } finally {
        setLoading(false);
      }
    }, 30);
  }
  async function openExample() {
    if (!okToReplace()) return;
    setLoading(true);
    try {
      let text: string;
      if (window.api) text = await window.api.readExample();
      else {
        const res = await fetch("./example.osm");
        if (!res.ok) throw new Error(tr("файл не найден ({0})", res.status));
        text = await res.text();
      }
      loadText(text, "example.osm", null);
    } catch (e) {
      setLoading(false);
      st.getState().toast(tr("Не удалось открыть пример: ") + (e instanceof Error ? e.message : e) + tr(". Запустите программу через npm start."));
    }
  }

  // «Посчитать» в свойствах дороги и на вкладке формул открывает таблицу расчета, даже если нижняя панель скрыта
  useEffect(() => {
    const open = () => setBottom("calc");
    window.addEventListener("wf-open-calc", open);
    return () => window.removeEventListener("wf-open-calc", open);
  }, []);

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
        <div className="brand" title={tr("Версия программы")}>
          <Logo size={28} />
          <span className="brand-text">
            <b>Wayfinder <small>v{VERSION}</small></b>
            <span className="file">{fileName || tr("Файл не открыт")}{dirty && <i className="dirty" title={tr("Есть несохраненные правки")} />}</span>
          </span>
        </div>
        <div className="tb-group">
          <button onClick={openFile} title={tr("Открыть .osm (Ctrl+O)")}><Icon name="folder" /><span className="lbl-1">{tr("Открыть")}</span></button>
          <button onClick={addMap} disabled={!data || loading} title={tr("Добавить карту: присоединить еще один .osm к открытой карте (соседний район или другой город). Дороги на стыке сшиваются")}><Icon name="addMap" /><span className="lbl-1">{tr("Карта")}</span></button>
          <button onClick={() => setDialog("import")} title={tr("Загрузить район или город из OpenStreetMap")}><Icon name="globe" /><span className="lbl-1">{tr("Из OSM")}</span></button>
          <button className="tb-save" onClick={() => setDialog("save")} disabled={!data} title={tr("Сохранить .osm (Ctrl+S)")}><Icon name="save" />{tr("Сохранить")}</button>
        </div>
        <div className="tb-group">
          <button className="tb-icon" onClick={() => st.getState().undo()} disabled={!past.length} title={tr("Отменить (Ctrl+Z)")}><Icon name="undo" /></button>
          <button className="tb-icon" onClick={() => st.getState().redo()} disabled={!future.length} title={tr("Повторить (Ctrl+Y)")}><Icon name="redo" /></button>
        </div>
        <StreetSearch onPick={() => setSide("props")} />
        <span className="grow" />
        <div className="tb-group">
          <button className={!view3d ? "on" : ""} onClick={() => setView3d(false)} title={tr("Вид сверху")}>2D</button>
          <button className={view3d ? "on" : ""} onClick={() => setView3d(true)} title={tr("Наклонный вид с объемными зданиями (3)")}>3D</button>
          <select value={basemap} onChange={(e) => setBasemap(e.target.value as Basemap)} title={tr("Подложка карты")}>
            <option value="map">{tr("Схема")}</option>
            <option value="satellite">{tr("Спутник")}</option>
          </select>
        </div>
        <div className="tb-group">
          <button className={heat ? "on" : ""} onClick={() => setHeat(!heat)} title={tr("Тепловая карта загрузки (H)")}><Icon name="gauge" /><span className="lbl-2">{tr("Загрузка Z")}</span></button>
          <button className={buildings ? "on" : ""} onClick={() => setBuildings(!buildings)} title={tr("Показать здания")}><Icon name="building" /><span className="lbl-2">{tr("Здания")}</span></button>
          <button className={changesOn ? "on" : ""} onClick={() => setChangesOn(!changesOn)} title={tr("Показать на карте новые, измененные и удаленные дороги")}><Icon name="diff" /><span className="lbl-2">{tr("Правки")}</span></button>
        </div>
        {/* тема, язык, руководство и горячие клавиши - в одном меню, чтобы строка не переносилась */}
        <AppMenu theme={theme} setTheme={setTheme} onGuide={() => setGuideOpen(true)} onKeys={() => setKeysOpen(true)} />
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
              <div className="optbar">{tr("Шаблон новой дороги:")}<select value={tpl} onChange={(e) => setTpl(e.target.value)}>{Object.entries(TEMPLATES).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}</select>
                <label className="check" title={tr("Точка прилипает к ближнему узлу или встает на линию дороги общим узлом")}><input type="checkbox" checked={magnet} onChange={(e) => setMagnet(e.target.checked)} />{tr("Магнит")}</label>
              </div>
            )}
          </MapView>
          {!data && (
            <div className="start">
              <Logo size={72} />
              <h1>Wayfinder</h1>
              <p>{tr("Редактор графа улично-дорожной сети. Открывает .osm, правит дороги, полосы, направления, светофоры и мосты, находит ошибки и сохраняет .osm для MatSim, SUMO и Webots.")}</p>
              <div className="start-btns">
                <button className="primary" onClick={openFile} disabled={loading}><Icon name="folder" />{tr("Открыть файл .osm")}</button>
                <button onClick={openExample} disabled={loading}><Icon name="addMap" />{tr("Открыть пример: Иркутск, example.osm")}</button>
                <button onClick={() => setDialog("import")} disabled={loading}><Icon name="globe" />{tr("Загрузить район из OpenStreetMap")}</button>
              </div>
              {loading && <p className="hint">{tr("Загрузка...")}</p>}
            </div>
          )}
          {bottom && data && (
            <section className="bottom" style={{ height: bottomHeight }}>
              <Resizer dir="y" value={bottomHeight} min={150} max={window.innerHeight - 250} onChange={setBottomHeight} />
              <div className="tabs">
                <button className={bottom === "calc" ? "on" : ""} onClick={() => setBottom("calc")}>{tr("Расчеты и графики")}</button>
                <button className={bottom === "compare" ? "on" : ""} onClick={() => setBottom("compare")}>{tr("Сравнение с исходным")}</button>
                <button className={bottom === "formulas" ? "on" : ""} onClick={() => setBottom("formulas")}>{tr("Формулы")}</button>
                <span className="grow" />
                <button className="hide" onClick={() => setBottom(null)} title={tr("Скрыть панель и отдать место карте")}><Icon name="chevronDown" size={14} /></button>
              </div>
              {bottom === "calc" && <CalcPanel />}
              {bottom === "compare" && <ComparePanel />}
              {bottom === "formulas" && <FormulasPanel />}
            </section>
          )}
          {!bottom && data && (
            <div className="bottom-rail" title={tr("Открыть нижнюю панель")}>
              <button onClick={() => setBottom("calc")}><Icon name="chevronUp" size={14} />{tr("Расчеты и графики")}</button>
              <button onClick={() => setBottom("compare")}><Icon name="chevronUp" size={14} />{tr("Сравнение с исходным")}</button>
              <button onClick={() => setBottom("formulas")}><Icon name="chevronUp" size={14} />{tr("Формулы")}</button>
            </div>
          )}
        </main>

        {!data ? null : side ? (
          <aside className="side">
            <Resizer dir="x" value={sideWidth} min={300} max={Math.round(window.innerWidth * 0.6)} onChange={setSideWidth} />
            <div className="tabs">
              <button className={side === "props" ? "on" : ""} onClick={() => setSide("props")}>{tr("Свойства")}</button>
              <button className={side === "errors" ? "on" : ""} onClick={() => setSide("errors")}>{tr("Ошибки")}{" "}{check && <span className={"badge" + (crit ? "" : " ok")}>{check.errors.length}</span>}</button>
              <button className={side === "routes" ? "on" : ""} onClick={() => setSide("routes")}>{tr("Маршруты")}</button>
              <button className={side === "history" ? "on" : ""} onClick={() => setSide("history")}>{tr("История")}</button>
              <span className="grow" />
              <button className="hide" onClick={() => setSide(null)} title={tr("Скрыть панель и отдать место карте")}><Icon name="chevronRight" size={14} /></button>
            </div>
            {side === "props" && <PropsPanel />}
            {side === "errors" && <ErrorsPanel />}
            {side === "history" && <HistoryPanel />}
            {side === "routes" && <RoutesPanel />}
          </aside>
        ) : (
          <aside className="rail" title={tr("Открыть правую панель")}>
            <button onClick={() => setSide("props")}><Icon name="chevronLeft" size={14} className="arrow" />{tr("Свойства")}</button>
            <button onClick={() => setSide("errors")}>{tr("Ошибки")}{" "}{check && <span className={"badge" + (crit ? "" : " ok")}>{check.errors.length}</span>}</button>
            <button onClick={() => setSide("routes")}>{tr("Маршруты")}</button>
            <button onClick={() => setSide("history")}>{tr("История")}</button>
          </aside>
        )}
      </div>

      <footer className="statusbar">
        {data ? (
          <>
            <span>{tr("Дорог:")}{" "}{[...data.ways.values()].filter((w) => w.tags.highway).length}</span>
            <span>{tr("Узлов в графе:")}{" "}{check?.nodes ?? 0}</span>
            <span>{tr("Светофоров на дорогах:")}{" "}{signals}</span>
            <span className={crit ? "c-danger" : "c-ok"}>{tr("Критичных ошибок:")}{" "}{crit}</span>
            <span>{tr("Правок:")}{" "}{past.length}</span>
            <span className="grow" />
            <button className={"keys-btn" + (keysOpen ? " on" : "")} onClick={() => setKeysOpen(!keysOpen)} title={tr("Список горячих клавиш (?)")}><kbd>?</kbd>{tr("Горячие клавиши")}</button>
          </>
        ) : <span>{tr("Откройте файл .osm, пример или загрузите район из OpenStreetMap")}</span>}
      </footer>

      {guideOpen && <GuideDialog onClose={() => setGuideOpen(false)} />}
      {keysOpen && (
        // список всех клавиш: открывается кнопкой справа внизу или клавишей «?», закрывается кликом мимо или Esc
        <div className="keys-back" onClick={() => setKeysOpen(false)}>
          <div className="keys-pop" onClick={(e) => e.stopPropagation()}>
            <h3>{tr("Горячие клавиши")}</h3>
            <dl>
              {HOTKEYS.map(([k, t]) => <div key={k}><dt>{k.split(" ").map((x) => <kbd key={x}>{x === "Клик" ? tr("Клик") : x}</kbd>)}</dt><dd>{tr(t)}</dd></div>)}
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
