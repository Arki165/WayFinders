import { useRef, useState } from "react";
import { useEditor, mergeMap } from "../model/store";
import { parseOsm } from "../osm/parse";
import { writeOsm } from "../osm/write";
import type { OsmData } from "../osm/types";
import { saveOsmText } from "../model/exporting";
import Icon from "./Icon";

// ---------- загрузка района из OpenStreetMap (Overpass API) ----------
// Серверы Overpass по порядку: если первый перегружен или недоступен, пробуем следующий.
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Загрузку отменили кнопкой «Отмена»: это не ошибка, сообщение не показываем
class Cancelled extends Error {}
const stopIfCancelled = (signal: AbortSignal) => { if (signal.aborted) throw new Cancelled("Загрузка отменена"); };

// Запрос к Overpass. Подпись программы (User-Agent) ставит electron/main.cjs:
// с подписью браузера overpass-api.de отвечает 406.
// Если перегружены все серверы, ждем и пробуем снова: Overpass часто отвечает 502/504 на минуту-другую,
// а крупный город - это два десятка запросов подряд, и один сбой не должен срывать всю загрузку.
const RETRY_WAIT_S = [15, 45];

// Ждать sec секунд, но сразу прерваться по кнопке «Отмена»
const pause = (sec: number, signal: AbortSignal) =>
  new Promise<void>((ok, fail) => {
    const t = setTimeout(ok, sec * 1000);
    signal.addEventListener("abort", () => { clearTimeout(t); fail(new Cancelled("Загрузка отменена")); }, { once: true });
  });

// onWait - показать человеку, что ждем сервер (иначе кажется, что программа зависла)
async function overpass(q: string, signal: AbortSignal, onWait?: (msg: string) => void): Promise<string> {
  for (let round = 0; ; round++) {
    const fails = await overpassRound(q, signal);
    if (typeof fails === "string") return fails; // это ответ сервера
    const why = fails.join(", ");
    if (why.includes("406")) throw new Error(`Серверы Overpass отклонили запрос (${why}). Запускайте загрузку из программы Wayfinder, а не из браузера.`);
    if (round >= RETRY_WAIT_S.length) throw new Error(`Серверы Overpass сейчас перегружены (${why}). Попробуйте через минуту или загрузите меньшую область.`);
    onWait?.(`Серверы Overpass перегружены (${why}), жду ${RETRY_WAIT_S[round]} с и пробую снова (попытка ${round + 2} из ${RETRY_WAIT_S.length + 1})...`);
    await pause(RETRY_WAIT_S[round], signal);
  }
}

// Один проход по всем серверам: текст ответа или список, кто чем ответил
async function overpassRound(q: string, signal: AbortSignal): Promise<string | string[]> {
  const fails: string[] = [];
  for (const url of OVERPASS) {
    stopIfCancelled(signal);
    const host = new URL(url).host;
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        // отмена кнопкой или зависший сервер (чуть дольше лимита запроса 600 с)
        signal: AbortSignal.any([signal, AbortSignal.timeout(660_000)]),
      });
      if (res.ok) return await res.text();
      // 400 - ошибка в самом запросе, другой сервер ответит так же
      if (res.status === 400) throw new Error("Сервер Overpass не понял запрос (400)");
      fails.push(`${host}: ${res.status}`);
    } catch (e) {
      stopIfCancelled(signal);
      if (e instanceof Error && e.message.includes("(400)")) throw e;
      fails.push(`${host}: нет ответа`);
    }
  }
  return fails;
}

type OsmEl = { type: string; id: number; tags: Record<string, string> };

// Найденный город: точка города в OSM и граница, по которой его скачивать
export interface CityChoice {
  key: number; // id точки города
  city: string;
  where: string; // страна и регион, чтобы отличить Москву от Moscow в США
  population: number;
  areaId: number; // область Overpass для скачивания
  area: string; // название границы
}

// "москва" -> "Москва", "new york" -> "New York": в OSM названия с большой буквы
const capitalize = (s: string) => s.replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

// Найти все города с таким названием (по-русски, по-английски, с маленькой буквы).
// Для каждого подбираем административную границу: в OSM граница часто называется
// не "Иркутск", а "городской округ Иркутск". Первым в списке идет самый крупный город.
async function findCities(input: string, signal: AbortSignal, onWait?: (msg: string) => void): Promise<CityChoice[]> {
  const names = [...new Set([input, capitalize(input)])];
  const keys = ["name", "name:ru", "name:en", "int_name"];
  const sel = names.flatMap((n) => keys.map((k) => `node["place"~"^(city|town)$"]["${k}"="${n}"];`)).join("");
  // для каждой найденной точки выводим ее саму и границы, в которые она попадает (уровни 2-8: от страны до поселения)
  const q = `[out:json][timeout:90];(${sel})->.p;foreach.p->.c(.c out tags;.c is_in->.a;area.a["boundary"="administrative"]["admin_level"~"^[2-8]$"];out tags;);`;
  const els: OsmEl[] = JSON.parse(await overpass(q, signal, onWait)).elements;

  // ответ идет группами: точка города, за ней ее границы
  const groups: { node: OsmEl; areas: OsmEl[] }[] = [];
  for (const e of els) {
    if (e.type === "node") groups.push({ node: e, areas: [] });
    else if (groups.length) groups[groups.length - 1].areas.push(e);
  }

  const level = (e: OsmEl) => Number(e.tags.admin_level);
  const deepest = (list: OsmEl[]) => list.reduce((a, b) => (level(b) > level(a) ? b : a));
  const out: CityChoice[] = [];
  for (const { node, areas } of groups) {
    const city = node.tags.name;
    if (!city) continue;
    // 1) граница с тем же названием (Москва - субъект уровня 4)
    // 2) граница, в названии которой есть город ("городской округ Иркутск", "Ангарский городской округ"), самая мелкая
    // 3) самая мелкая граница уровня 5-8, но не субъект целиком
    const exact = areas.find((a) => a.tags.name === city && level(a) >= 4);
    const stem = city.toLowerCase().slice(0, Math.max(4, city.length - 1)); // "Ангарск" -> "ангарс" (подходит к "Ангарский")
    const named = areas.filter((a) => level(a) >= 5 && a.tags.name?.toLowerCase().includes(stem));
    const local = areas.filter((a) => level(a) >= 5);
    const area = exact ?? (named.length ? deepest(named) : local.length ? deepest(local) : null);
    if (!area || out.some((c) => c.areaId === area.id)) continue; // без границы скачать нельзя; одна граница - один вариант
    const country = areas.find((a) => level(a) === 2)?.tags.name;
    const region = areas.find((a) => level(a) === 4 && a.tags.name !== city)?.tags.name;
    out.push({
      key: node.id, city, where: [country, region].filter(Boolean).join(", "),
      population: Number((node.tags.population ?? "0").replace(/\D/g, "")) || 0,
      areaId: area.id, area: area.tags.name,
    });
  }
  if (!out.length) throw new Error(`Город «${input}» не найден в OpenStreetMap. Проверьте написание, например «Ангарск» или «Moscow».`);
  return out.sort((a, b) => b.population - a.population);
}

const fmtPop = (p: number) => (p >= 1e6 ? `${(p / 1e6).toFixed(1).replace(".", ",")} млн жителей` : p >= 1e3 ? `${Math.round(p / 1e3)} тыс. жителей` : "население не указано");

// Город крупнее этого скачиваем кусками: целиком Москву (больше 400 МБ одних дорог) сервер не отдает
const BIG_CITY = 1_500_000;
// Размер куска, градусы: около 13 x 13 км в средней полосе
const TILE_LAT = 0.12, TILE_LON = 0.2;

// Overpass при нехватке времени или памяти отдает 200, но обрезанные данные и пишет об этом в <remark>.
// Такой файл грузить нельзя: часть города просто пропадет.
function checkComplete(xml: string) {
  const m = xml.match(/<remark>([\s\S]*?)<\/remark>/);
  if (!m) return;
  const msg = m[1].trim();
  if (/timed out|timeout/i.test(msg)) throw new Error("Сервер Overpass не успел отдать данные целиком (не хватило времени). Снимите галочку «Вместе со зданиями» или загрузите видимую область.");
  if (/out of memory|memory/i.test(msg)) throw new Error("Слишком много данных для сервера Overpass (не хватило памяти). Снимите галочку «Вместе со зданиями» или загрузите видимую область.");
  throw new Error("Сервер Overpass вернул неполные данные: " + msg.slice(0, 200));
}

// Добавить кусок в общий результат. Дорога на стыке двух кусков приходит в обоих целиком,
// поэтому повторы просто пропускаем по id.
function addPart(acc: OsmData, part: OsmData) {
  for (const [id, n] of part.nodes) if (!acc.nodes.has(id)) acc.nodes.set(id, n);
  for (const [id, w] of part.ways) if (!acc.ways.has(id)) acc.ways.set(id, w);
  for (const [id, r] of part.relations) if (!acc.relations.has(id)) acc.relations.set(id, r);
  if (part.bounds) {
    const b = acc.bounds, p = part.bounds;
    acc.bounds = b ? { minlat: Math.min(b.minlat, p.minlat), minlon: Math.min(b.minlon, p.minlon), maxlat: Math.max(b.maxlat, p.maxlat), maxlon: Math.max(b.maxlon, p.maxlon) } : { ...p };
  }
}

type Downloaded = { data: OsmData; dl: number; parse: number; mb: number };

export function ImportDialog({ onClose, getBounds }: { onClose: () => void; getBounds: () => [number, number, number, number] | null }) {
  const load = useEditor((s) => s.load);
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [withBuildings, setWithBuildings] = useState(true);
  // если карта уже открыта, новый район по умолчанию присоединяется к ней
  const hasMap = useEditor((s) => !!s.data);
  const [merge, setMerge] = useState(hasMap);
  const [stage, setStage] = useState(""); // что сейчас делает загрузка
  const [choices, setChoices] = useState<CityChoice[]>([]); // несколько городов с одним названием
  const abort = useRef<AbortController | null>(null);

  // A - область поиска; extra - что еще скачать вместе с дорогами (например, саму границу города)
  const body = (head: string, extra = "") =>
    `${head}(way["highway"](A);way["railway"~"tram|rail|subway"](A);${withBuildings ? 'way["building"](A);' : ""}node["highway"~"traffic_signals|crossing|bus_stop"](A);node["railway"~"station|halt|tram_stop|subway_entrance"](A);relation["route"="subway"](A);relation["type"="restriction"](A);${extra});(._;>;)->.base;relation["route"~"^(bus|trolleybus|tram|share_taxi)$"](A)->.routes;(.base;.routes;);out meta;`;

  // Скачать город по границе. Крупный - кусками, иначе одним запросом.
  async function downloadCity(c: CityChoice, signal: AbortSignal): Promise<Downloaded> {
    // Граница города (отношение OSM) скачивается вместе с дорогами и сохраняется в .osm:
    // по ней проверка графа понимает, что дорога обрезана краем города, а не разорвана.
    // id области = 3600000000 + id отношения; область из линии (2400000000+) пропускаем.
    const relId = c.areaId - 3600000000;
    const boundary = relId > 0 ? `rel(${relId});` : "";
    const what = `дороги${withBuildings ? " и здания" : ""}`;
    let dl = 0, parse = 0, mb = 0;

    // рамки кусков: для крупного города режем рамку его границы на квадраты
    let tiles: string[] = [""];
    if (c.population > BIG_CITY && relId > 0) {
      setStage(`${c.city}: крупный город, узнаю размеры, чтобы скачать кусками...`);
      const t = performance.now();
      const bb = JSON.parse(await overpass(`[out:json][timeout:60];rel(${relId});out bb;`, signal, setStage)).elements[0]?.bounds;
      dl += performance.now() - t;
      if (bb) {
        const ny = Math.ceil((bb.maxlat - bb.minlat) / TILE_LAT), nx = Math.ceil((bb.maxlon - bb.minlon) / TILE_LON);
        tiles = [];
        for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
          const s = bb.minlat + i * TILE_LAT, w = bb.minlon + j * TILE_LON;
          tiles.push(`(${s.toFixed(5)},${w.toFixed(5)},${Math.min(s + TILE_LAT, bb.maxlat).toFixed(5)},${Math.min(w + TILE_LON, bb.maxlon).toFixed(5)})`);
        }
      }
    }

    const data: OsmData = { nodes: new Map(), ways: new Map(), relations: new Map(), bounds: null, header: {} };
    for (let i = 0; i < tiles.length; i++) {
      stopIfCancelled(signal);
      const part = tiles.length > 1 ? `Кусок ${i + 1} из ${tiles.length}: ` : "";
      setStage(`${part}${c.city}, граница «${c.area}». Скачиваю ${what}...${mb ? ` Уже ${mb.toFixed(0)} МБ.` : ""}`);
      // граница скачивается один раз, с первым куском; в куске - только то, что внутри и границы, и квадрата
      const q = body(`[out:xml][timeout:600];area(${c.areaId})->.a;`, i === 0 ? boundary : "").replace(/\(A\)/g, `(area.a)${tiles[i]}`);
      let t = performance.now();
      const text = await overpass(q, signal, (m) => setStage(part + m));
      dl += performance.now() - t;
      checkComplete(text);
      mb += text.length / 1e6;
      setStage(`${part}получено ${mb.toFixed(0)} МБ, разбираю...`);
      await new Promise((r) => setTimeout(r, 0)); // дать окну показать надпись перед долгим разбором
      t = performance.now();
      const p = parseOsm(text);
      if (i === 0) data.header = p.header;
      addPart(data, p);
      parse += performance.now() - t;
    }
    return { data, dl, parse, mb };
  }

  // Скачать (view - видимую область, city - город по названию или выбранный из списка) и открыть
  async function run(kind: "view" | "city", chosen?: CityChoice) {
    setErr("");
    setChoices([]);
    // название без кавычек и обратных слешей, чтобы не сломать запрос
    const cityName = city.trim().replace(/["\\]/g, "");
    const b = getBounds();
    if (kind === "view") {
      if (!b) return setErr("Карта еще не готова");
      const [s, w, n, e] = b;
      if ((n - s) * (e - w) > 0.02) return setErr("Область слишком большая, приблизьте карту или загрузите город по названию");
    } else if (!cityName && !chosen) return setErr("Введите название города");
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setStage(kind === "view" ? "Скачиваю видимую область..." : "");
    try {
      const t0 = performance.now();
      let res: Downloaded;
      let name: string;
      if (kind === "view") {
        const [s, w, n, e] = b!;
        const t = performance.now();
        const text = await overpass(body("[out:xml][timeout:120];").replace(/\(A\)/g, `(${s},${w},${n},${e})`), ctl.signal, setStage);
        const dl = performance.now() - t;
        checkComplete(text);
        const t2 = performance.now();
        res = { data: parseOsm(text), dl, parse: performance.now() - t2, mb: text.length / 1e6 };
        name = `area_${s.toFixed(3)}_${w.toFixed(3)}.osm`;
      } else {
        let c = chosen;
        if (!c) {
          setStage(`Ищу город «${cityName}»...`);
          const found = await findCities(cityName, ctl.signal, setStage);
          // несколько городов с таким названием: пусть человек выберет нужный
          if (found.length > 1) { setChoices(found); return; }
          c = found[0];
        }
        res = await downloadCity(c, ctl.signal);
        name = `${c.city}.osm`;
      }
      stopIfCancelled(ctl.signal);
      const data = res.data;
      if (!data.ways.size) throw new Error("В этой области нет дорог");
      setStage(`Открываю ${data.ways.size} линий и проверяю граф...`);
      await new Promise((r) => setTimeout(r, 0));
      const t3 = performance.now();
      const merged = merge && hasMap ? mergeMap(data, name) : (load(data, name, null), null);
      const open = performance.now() - t3;
      // время по частям: пригодится, чтобы объяснить жюри, где тратятся секунды
      const sec = (ms: number) => (ms / 1000).toFixed(1).replace(".", ",");
      const times = `за ${sec(performance.now() - t0)} с (скачивание ${sec(res.dl)} с, ${res.mb.toFixed(0)} МБ; разбор ${sec(res.parse)} с; открытие и проверка ${sec(open)} с)`;
      if (merged) useEditor.getState().toast(`Район присоединен: ${merged.ways} новых линий ${times}. На стыке сшито дорог: ${merged.stitched}`);
      else useEditor.getState().toast(`Загружено: ${data.ways.size} линий, ${data.nodes.size} узлов ${times}`);
      onClose();
    } catch (e) {
      if (!(e instanceof Cancelled)) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
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
          <input placeholder="Название города, например Ангарск" value={city} onChange={(e) => { setCity(e.target.value); setChoices([]); }} onKeyDown={(e) => e.key === "Enter" && !busy && run("city")} disabled={busy} />
          <button disabled={busy} onClick={() => run("city")}>Скачать город</button>
        </div>
        {choices.length > 0 && (
          // стили прямо здесь, чтобы не трогать общий index.css (он у компьютера 1)
          <div style={{ display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
            <p className="hint" style={{ margin: 0 }}>Городов с таким названием несколько, выберите нужный:</p>
            {choices.map((c) => (
              <button key={c.key} onClick={() => run("city", c)} disabled={busy} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, textAlign: "left", padding: "6px 10px", height: "auto" }}>
                <b>{c.city}</b>
                <span className="hint" style={{ margin: 0 }}>{c.where || "страна не указана"} · {fmtPop(c.population)}{c.population > BIG_CITY ? " · скачается кусками" : ""}</span>
              </button>
            ))}
          </div>
        )}
        {hasMap && <label className="opt"><input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} disabled={busy} /> Присоединить к открытой карте (иначе открытая карта заменится)</label>}
        <label className="opt"><input type="checkbox" checked={withBuildings} onChange={(e) => setWithBuildings(e.target.checked)} disabled={busy} /> Вместе со зданиями (нужны для 3D и Webots)</label>
        {busy && <p className="hint">{stage || "Загрузка..."} Крупный город может скачиваться несколько минут.</p>}
        {err && <p className="error">{err}</p>}
        <div className="foot">
          {busy ? <button onClick={() => abort.current?.abort()}>Отмена</button> : <button onClick={onClose}>Закрыть</button>}
        </div>
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
          <div><span className={"ico " + (crit ? "bad" : "ok")}><Icon name={crit ? "close" : "check"} size={13} /></span>{crit ? `Критичных ошибок: ${crit}. Машины будут телепортироваться или стоять.` : "Критичных ошибок нет"}</div>
          <div><span className={"ico " + (warn ? "warn" : "ok")}><Icon name={warn ? "alert" : "check"} size={13} /></span>{warn ? `Предупреждений: ${warn}` : "Предупреждений нет"}</div>
          <div><span className={"ico " + (pct >= 95 ? "ok" : "warn")}><Icon name={pct >= 95 ? "check" : "alert"} size={13} /></span>Связность по направлениям: {pct.toFixed(1)}% узлов{pct >= 95 ? "" : ", цель 95%"}</div>
          <div><span className="ico ok"><Icon name="check" size={13} /></span>{newCount ? `${newCount} новых элементов получат положительные id` : "Новых элементов нет"}</div>
          <div><span className="ico ok"><Icon name="check" size={13} /></span>Здания, остановки, маршруты и запреты поворотов сохранятся без изменений</div>
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
