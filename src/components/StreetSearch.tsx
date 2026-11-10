// Поиск в верхней панели: улицы, остановки и номера дорог.
// Список подсказок появляется под полем по мере ввода, выбор стрелками и Enter.
// Выбранная улица выделяется целиком (все ее участки), и карта показывает ее всю.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as KeyEvent } from "react";
import { useEditor } from "../model/store";
import { ROAD_CLASSES, isDrivable } from "../model/roads";
import { wayLengthM } from "../model/geo";
import { poiKind } from "../model/poi";
import Icon from "./Icon";

type Box = [number, number, number, number]; // запад, юг, восток, север
interface Street { kind: "street"; name: string; key: string; ids: number[]; len: number; box: Box; rank: number }
interface Stop { kind: "stop"; name: string; key: string; id: number; lat: number; lon: number; sub: string }
type Hit = Street | Stop;

const MAX = 8; // сколько подсказок показывать

// Для сравнения: строчные буквы и «е» вместо «ё»
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
// Слова названия: «улица Академика Курчатова» -> [улица, академика, курчатова]
const words = (s: string) => norm(s).split(/[\s\-.,«»"()/]+/).filter(Boolean);
// Служебные слова, по ним одним улицу не ищем
const TYPE_WORDS = new Set(["улица", "ул", "переулок", "пер", "проезд", "проспект", "пр", "бульвар", "шоссе", "площадь", "набережная", "тупик", "дорога", "мост", "микрорайон"]);

// Насколько хорошо название подходит к запросу: 0 - лучше всего, null - не подходит
function score(name: string, q: string[]): number | null {
  const ws = words(name);
  let s = 0;
  for (const part of q) {
    const i = ws.findIndex((w) => w.startsWith(part));
    if (i >= 0) { if (TYPE_WORDS.has(ws[i]) && q.length === 1) s += 2; continue; }
    if (part.length >= 3 && norm(name).includes(part)) { s += 3; continue; } // середина слова
    return null;
  }
  if (norm(name).startsWith(q.join(" "))) s -= 1;
  return s;
}

export default function StreetSearch({ onPick }: { onPick: () => void }) {
  const data = useEditor((s) => s.data);
  const version = useEditor((s) => s.version);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Справочник для поиска: улицы собраны по названию из всех участков, плюс остановки.
  // Пересчитывается только после правки, а не на каждую букву.
  const index = useMemo(() => {
    const out: Hit[] = [];
    if (!data) return out;
    const streets = new Map<string, Street>();
    for (const w of data.ways.values()) {
      const name = w.tags.name;
      if (!w.tags.highway || !name) continue;
      let st = streets.get(name);
      if (!st) { st = { kind: "street", name, key: "s" + name, ids: [], len: 0, box: [180, 90, -180, -90], rank: 0 }; streets.set(name, st); }
      st.ids.push(w.id);
      st.len += wayLengthM(data, w);
      if (isDrivable(w)) st.rank = Math.max(st.rank, ROAD_CLASSES[w.tags.highway]?.rank ?? 0);
      for (const id of w.nodeIds) {
        const n = data.nodes.get(id);
        if (!n) continue;
        st.box = [Math.min(st.box[0], n.lon), Math.min(st.box[1], n.lat), Math.max(st.box[2], n.lon), Math.max(st.box[3], n.lat)];
      }
    }
    out.push(...streets.values());
    // остановки с одинаковым названием показываем один раз
    const seen = new Set<string>();
    for (const n of data.nodes.values()) {
      const k = poiKind(n);
      if ((k !== "bus" && k !== "tram") || !n.tags.name) continue;
      const key = k + n.tags.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "stop", name: n.tags.name, key: "p" + n.id, id: n.id, lat: n.lat, lon: n.lon, sub: k === "tram" ? "Остановка трамвая" : "Остановка автобуса" });
    }
    return out;
  }, [data, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Подсказки по запросу: лучшие совпадения сверху, среди равных - главные и длинные улицы
  const qw = words(q);
  const found = useMemo(() => {
    if (!qw.length || !data) return [] as Hit[];
    // номер дороги или узла тоже можно найти
    if (/^-?\d{3,}$/.test(q.trim())) {
      const id = Number(q.trim());
      const w = data.ways.get(id), n = data.nodes.get(id);
      const res: Hit[] = [];
      if (w) res.push({ kind: "street", name: w.tags.name || `Дорога ${id}`, key: "w" + id, ids: [id], len: wayLengthM(data, w), box: boxOf(w.nodeIds.map((x) => data.nodes.get(x)!).filter(Boolean)), rank: 0 });
      if (n) res.push({ kind: "stop", name: n.tags.name || `Узел ${id}`, key: "n" + id, id, lat: n.lat, lon: n.lon, sub: "Узел графа" });
      return res;
    }
    const scored: { h: Hit; s: number }[] = [];
    for (const h of index) { const s = score(h.name, qw); if (s !== null) scored.push({ h, s }); }
    scored.sort((a, b) => a.s - b.s || weight(b.h) - weight(a.h) || a.h.name.localeCompare(b.h.name, "ru"));
    return scored.map((x) => x.h);
  }, [q, index]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = found.slice(0, MAX);

  // новый запрос - подсветка снова на первой строке
  useEffect(() => setActive(0), [q]);

  // Ctrl+F (или Cmd+F) ставит курсор в поиск
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "а")) { e.preventDefault(); input.current?.focus(); input.current?.select(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function pick(h: Hit) {
    const s = useEditor.getState();
    if (h.kind === "street") {
      s.setHighlight(h.ids);
      s.select(h.ids.length === 1 ? { kind: "way", id: h.ids[0] } : { kind: "ways", ids: h.ids });
      s.fitTo(h.box);
    } else {
      s.setHighlight([]);
      s.select({ kind: "node", id: h.id });
      s.flyTo(h.lat, h.lon, 18);
    }
    setQ(h.name);
    setOpen(false);
    input.current?.blur();
    onPick();
  }

  function clear() {
    setQ("");
    useEditor.getState().setHighlight([]);
  }

  function onKeyDown(e: KeyEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { if (shown[active]) pick(shown[active]); }
    else if (e.key === "Escape") { if (q) clear(); else input.current?.blur(); setOpen(false); }
  }

  return (
    <div className="search">
      <label className="tb-search">
        <Icon name="search" size={16} />
        <input
          ref={input}
          value={q}
          placeholder="Улица или остановка"
          disabled={!data}
          title="Поиск улиц и остановок (Ctrl+F)"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {q && <button className="search-clear" title="Очистить и снять подсветку" onMouseDown={(e) => e.preventDefault()} onClick={clear}><Icon name="close" size={14} /></button>}
      </label>
      {open && qw.length > 0 && (
        // onMouseDown с preventDefault: клик по списку не уводит фокус из поля раньше времени
        <div className="search-list" onMouseDown={(e) => e.preventDefault()}>
          {shown.map((h, i) => (
            <button key={h.key} className={"search-item" + (i === active ? " active" : "")} onMouseEnter={() => setActive(i)} onClick={() => pick(h)}>
              <span className={"search-ic " + h.kind}><Icon name={h.kind === "street" ? "road" : "stop"} size={16} /></span>
              <span className="search-text">
                <span className="search-name"><Marked text={h.name} q={qw} /></span>
                <small>{h.kind === "street" ? streetInfo(h) : h.sub}</small>
              </span>
            </button>
          ))}
          {!shown.length && <div className="search-empty">Ничего не найдено. Можно ввести часть названия или номер дороги.</div>}
          {found.length > MAX && <div className="search-more">Показаны {MAX} из {found.length}. Уточните запрос</div>}
        </div>
      )}
    </div>
  );
}

// Главные улицы выше в списке, потом по длине
const weight = (h: Hit) => (h.kind === "street" ? h.rank * 100000 + h.len : -1);

function streetInfo(h: Street): string {
  const n = h.ids.length;
  const parts = n % 10 === 1 && n % 100 !== 11 ? "участок" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "участка" : "участков";
  const len = h.len >= 1000 ? `${(h.len / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км` : `${Math.round(h.len)} м`;
  return `${n} ${parts} · ${len}`;
}

function boxOf(ns: { lat: number; lon: number }[]): Box {
  return [Math.min(...ns.map((n) => n.lon)), Math.min(...ns.map((n) => n.lat)), Math.max(...ns.map((n) => n.lon)), Math.max(...ns.map((n) => n.lat))];
}

// Название с выделенным совпадением: начало слова, которое ввели в поиск
function Marked({ text, q }: { text: string; q: string[] }) {
  const tokens = text.split(/(\s+|-)/);
  return (
    <>
      {tokens.map((t, i) => {
        const part = q.find((p) => norm(t).startsWith(p));
        return part ? <span key={i}><mark>{t.slice(0, part.length)}</mark>{t.slice(part.length)}</span> : <span key={i}>{t}</span>;
      })}
    </>
  );
}
