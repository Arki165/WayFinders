import { useState } from "react";
import { useEditor } from "../model/store";
import { parseOsm } from "../osm/parse";
import { writeOsm } from "../osm/write";
import { saveOsmText } from "../model/exporting";

// ---------- загрузка района из OpenStreetMap (Overpass API) ----------
export function ImportDialog({ onClose, getBounds }: { onClose: () => void; getBounds: () => [number, number, number, number] | null }) {
  const load = useEditor((s) => s.load);
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [withBuildings, setWithBuildings] = useState(true);

  const body = (area: string) =>
    `[out:xml][timeout:120];${area}(way["highway"](A);way["railway"~"tram|rail"](A);${withBuildings ? 'way["building"](A);' : ""}node["highway"~"traffic_signals|crossing|bus_stop"](A);relation["type"="restriction"](A););(._;>;);out meta;`;

  async function run(kind: "view" | "city") {
    setErr("");
    let q: string;
    let name: string;
    if (kind === "view") {
      const b = getBounds();
      if (!b) return setErr("Карта еще не готова");
      const [s, w, n, e] = b;
      if ((n - s) * (e - w) > 0.02) return setErr("Область слишком большая, приблизьте карту или загрузите город по названию");
      q = body("").replace(/\(A\)/g, `(${s},${w},${n},${e})`);
      name = `area_${s.toFixed(3)}_${w.toFixed(3)}.osm`;
    } else {
      if (!city.trim()) return setErr("Введите название города");
      q = `[out:xml][timeout:180];area["name"="${city.trim().replace(/"/g, "")}"]["boundary"="administrative"]->.a;` + body("").replace("[out:xml][timeout:120];", "").replace(/\(A\)/g, "(area.a)");
      name = `${city.trim()}.osm`;
    }
    setBusy(true);
    try {
      const t0 = performance.now();
      const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (!res.ok) throw new Error(`Сервер Overpass ответил ${res.status}`);
      const text = await res.text();
      const data = parseOsm(text);
      if (!data.ways.size) throw new Error("В этой области нет дорог");
      load(data, name, null);
      useEditor.getState().toast(`Загружено: ${data.ways.size} линий, ${data.nodes.size} узлов за ${((performance.now() - t0) / 1000).toFixed(1)} с`);
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
