import { useState } from "react";
import { useEditor, mergeMap } from "../model/store";
import { parseOsm } from "../osm/parse";
import { writeOsm } from "../osm/write";
import { saveOsmText } from "../model/exporting";

// ---------- загрузка района из OpenStreetMap (Overpass API) ----------
// Серверы Overpass по порядку: если первый перегружен или недоступен, пробуем следующий.
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Запрос к Overpass. Подпись программы (User-Agent) ставит electron/main.cjs:
// с подписью браузера overpass-api.de отвечает 406.
async function overpass(q: string): Promise<string> {
  const fails: string[] = [];
  for (const url of OVERPASS) {
    const host = new URL(url).host;
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(240_000), // зависший сервер не держит загрузку дольше 4 минут
      });
      if (res.ok) return res.text();
      // 400 - ошибка в самом запросе, другой сервер ответит так же
      if (res.status === 400) throw new Error("Сервер Overpass не понял запрос (400)");
      fails.push(`${host}: ${res.status}`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("(400)")) throw e;
      fails.push(`${host}: нет ответа`);
    }
  }
  const why = fails.join(", ");
  if (why.includes("406")) throw new Error(`Серверы Overpass отклонили запрос (${why}). Запускайте загрузку из программы WayFinders, а не из браузера.`);
  throw new Error(`Серверы Overpass сейчас перегружены (${why}). Попробуйте через минуту или загрузите меньшую область.`);
}

// Найти границу города по названию. В OSM граница часто называется не "Иркутск",
// а "городской округ Иркутск", поэтому ищем точку города (place=city/town)
// и берем самую мелкую административную границу, в которую она попадает.
async function findCityArea(city: string): Promise<number> {
  const q = `[out:json][timeout:60];node["place"~"^(city|town)$"]["name"="${city}"]->.p;.p is_in->.a;area.a["boundary"="administrative"]["admin_level"~"^[5-8]$"];out tags;`;
  const els: { id: number; tags: Record<string, string> }[] = JSON.parse(await overpass(q)).elements;
  if (!els.length) throw new Error(`Город «${city}» не найден в OpenStreetMap. Проверьте написание, например «Ангарск».`);
  // граница с точным названием лучше всего, иначе самая мелкая (больший admin_level)
  const exact = els.find((e) => e.tags.name === city);
  if (exact) return exact.id;
  return els.reduce((a, b) => (Number(b.tags.admin_level) > Number(a.tags.admin_level) ? b : a)).id;
}

export function ImportDialog({ onClose, getBounds }: { onClose: () => void; getBounds: () => [number, number, number, number] | null }) {
  const load = useEditor((s) => s.load);
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [withBuildings, setWithBuildings] = useState(true);
  // если карта уже открыта, новый район по умолчанию присоединяется к ней
  const hasMap = useEditor((s) => !!s.data);
  const [merge, setMerge] = useState(hasMap);

  const body = (area: string) =>
    `[out:xml][timeout:120];${area}(way["highway"](A);way["railway"~"tram|rail"](A);${withBuildings ? 'way["building"](A);' : ""}node["highway"~"traffic_signals|crossing|bus_stop"](A);relation["type"="restriction"](A););(._;>;);out meta;`;

  async function run(kind: "view" | "city") {
    setErr("");
    // название без кавычек и обратных слешей, чтобы не сломать запрос
    const cityName = city.trim().replace(/["\\]/g, "");
    const b = getBounds();
    if (kind === "view") {
      if (!b) return setErr("Карта еще не готова");
      const [s, w, n, e] = b;
      if ((n - s) * (e - w) > 0.02) return setErr("Область слишком большая, приблизьте карту или загрузите город по названию");
    } else if (!cityName) return setErr("Введите название города");
    setBusy(true);
    try {
      const t0 = performance.now();
      let q: string;
      let name: string;
      if (kind === "view") {
        const [s, w, n, e] = b!;
        q = body("").replace(/\(A\)/g, `(${s},${w},${n},${e})`);
        name = `area_${s.toFixed(3)}_${w.toFixed(3)}.osm`;
      } else {
        const areaId = await findCityArea(cityName);
        q = `[out:xml][timeout:180];area(${areaId})->.a;` + body("").replace("[out:xml][timeout:120];", "").replace(/\(A\)/g, "(area.a)");
        name = `${cityName}.osm`;
      }
      const text = await overpass(q);
      const data = parseOsm(text);
      if (!data.ways.size) throw new Error("В этой области нет дорог");
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      if (merge && hasMap) {
        const r = mergeMap(data, name);
        if (r) useEditor.getState().toast(`Район присоединен: ${r.ways} новых линий за ${sec} с. На стыке сшито дорог: ${r.stitched}`);
      } else {
        load(data, name, null);
        useEditor.getState().toast(`Загружено: ${data.ways.size} линий, ${data.nodes.size} узлов за ${sec} с`);
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog">
        <h2>Загрузить район из OpenStreetMap</h2>
        <p className="hint">Редактор работает с любым городом: данные скачиваются из OpenStreetMap через Overpass API в том же формате .osm.</p>
        <button className="primary" disabled={busy} onClick={() => run("view")}>Скачать видимую область карты</button>
        <div className="row">
          <input placeholder="Название города, например Ангарск" value={city} onChange={(e) => setCity(e.target.value)} disabled={busy} />
          <button disabled={busy} onClick={() => run("city")}>Скачать город</button>
        </div>
        {hasMap && <label className="opt"><input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} disabled={busy} /> Присоединить к открытой карте (иначе открытая карта заменится)</label>}
        <label className="opt"><input type="checkbox" checked={withBuildings} onChange={(e) => setWithBuildings(e.target.checked)} /> Вместе со зданиями (нужны для 3D и Webots)</label>
        {busy && <p className="hint">Загрузка... крупный город может скачиваться минуту и больше.</p>}
        {err && <p className="error">{err}</p>}
        <div className="foot"><button onClick={onClose} disabled={busy}>Закрыть</button></div>
      </div>
    </div>
  );
}

// ---------- сохранение с проверкой ----------
export function SaveDialog({ onClose }: { onClose: () => void }) {
  const data = useEditor((s) => s.data)!;
  const check = useEditor((s) => s.check)!;
  const fileName = useEditor((s) => s.fileName);
  const filePath = useEditor((s) => s.filePath);
  const setTab = useEditor((s) => s.toast);
  const [name, setName] = useState(fileName.replace(/\.osm$/i, "") + "_edited.osm");
  const crit = check.errors.filter((e) => e.sev === "danger").length;
  const warn = check.errors.filter((e) => e.sev === "warn").length;
  const pct = check.nodes ? (check.sccMain / check.nodes) * 100 : 100;
  const newCount = [...data.ways.keys()].filter((id) => id < 0).length + [...data.nodes.keys()].filter((id) => id < 0).length;

  async function save(overwrite: boolean) {
    const text = writeOsm(data);
    let p: string | null | undefined;
    if (overwrite && filePath && window.api) p = await window.api.writeFile(filePath, text);
    else p = await saveOsmText(/\.osm$/i.test(name) ? name : name + ".osm", text);
    if (p) { useEditor.getState().toast("Сохранено: " + p); onClose(); }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <h2>Сохранение графа в .osm</h2>
        <div className="checks">
          <div><span className={"ico " + (crit ? "bad" : "ok")}>{crit ? "✕" : "✓"}</span>{crit ? `Критичных ошибок: ${crit}. Машины будут телепортироваться или стоять.` : "Критичных ошибок нет"}</div>
          <div><span className={"ico " + (warn ? "warn" : "ok")}>{warn ? "!" : "✓"}</span>{warn ? `Предупреждений: ${warn}` : "Предупреждений нет"}</div>
          <div><span className={"ico " + (pct >= 95 ? "ok" : "warn")}>{pct >= 95 ? "✓" : "!"}</span>Связность по направлениям: {pct.toFixed(1)}% узлов{pct >= 95 ? "" : ", цель 95%"}</div>
          <div><span className="ico ok">✓</span>{newCount ? `${newCount} новых элементов получат положительные id` : "Новых элементов нет"}</div>
          <div><span className="ico ok">✓</span>Здания, остановки, маршруты и запреты поворотов сохранятся без изменений</div>
        </div>
        <label className="field">Имя файла
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <span className="hint">Сервер проверки принимает файл с именем команды: команда team1 отправляет team1.osm.</span>
        </label>
        <div className="foot">
          {crit > 0 && <button onClick={() => { onClose(); setTab("Откройте вкладку «Ошибки» справа"); }}>Сначала исправить</button>}
          {filePath && window.api && <button onClick={() => save(true)}>Перезаписать {fileName}</button>}
          <button className="primary" onClick={() => save(false)}>Сохранить как...</button>
          <button onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}
