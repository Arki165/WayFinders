// Язык интерфейса: русский или английский.
// Все тексты в коде написаны по-русски и проходят через tr(): на русском tr возвращает текст как есть,
// на английском ищет перевод в словаре EN (файл i18n.en.ts). Числа и названия подставляются в {0}, {1}...
import { create } from "zustand";
import { EN } from "./i18n.en";

export type Lang = "ru" | "en";

function loadLang(): Lang {
  try { return localStorage.getItem("lang") === "en" ? "en" : "ru"; } catch { return "ru"; }
}

// Текущий язык хранится и в переменной (для tr), и в маленьком хранилище (чтобы окно перерисовалось)
let current: Lang = loadLang();
export const useLang = create<{ lang: Lang; setLang: (l: Lang) => void }>((set) => ({
  lang: current,
  setLang: (lang) => {
    current = lang;
    try { localStorage.setItem("lang", lang); } catch { /* хранилище недоступно */ }
    document.documentElement.lang = lang;
    set({ lang });
  },
}));
document.documentElement.lang = current;

export const lang = () => current;

// Перевод строки. tr("Дорог: {0}", 861) -> "Дорог: 861" или "Roads: 861"
export function tr(ru: string, ...args: (string | number)[]): string {
  let s = current === "en" ? EN[ru] ?? missing(ru) : ru;
  args.forEach((a, i) => { s = s.split(`{${i}}`).join(String(a)); });
  return s;
}

// Строки без перевода в режиме разработки пишем в консоль один раз: так их легко найти и добавить
const reported = new Set<string>();
function missing(ru: string): string {
  if (import.meta.env.DEV && !reported.has(ru)) { reported.add(ru); console.warn("[перевод] нет английского:", ru); }
  return ru;
}

// Числа: на русском «1 234,5», на английском «1,234.5»
export const locale = () => (current === "en" ? "en-US" : "ru-RU");

// ---------- названия улиц и остановок латиницей ----------
// Буквы по ГОСТ Р 52290-2004 (так пишут на дорожных указателях в России), мягкий и твердый знак не пишем
const LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
export function translit(s: string): string {
  let out = "";
  for (const ch of s) {
    const low = ch.toLowerCase();
    const t = LAT[low];
    if (t === undefined) { out += ch; continue; }
    // заглавная буква остается заглавной: «Щ» -> «Shch»
    out += ch !== low && t ? t[0].toUpperCase() + t.slice(1) : t;
  }
  return out;
}

// Тип улицы переводим и ставим после названия, как принято по-английски
const STREET_TYPES: [RegExp, string][] = [
  [/^улица$/i, "Street"], [/^ул\.?$/i, "St"], [/^проспект$/i, "Avenue"], [/^переулок$/i, "Lane"], [/^проезд$/i, "Drive"],
  [/^бульвар$/i, "Boulevard"], [/^шоссе$/i, "Highway"], [/^площадь$/i, "Square"], [/^набережная$/i, "Embankment"],
  [/^тупик$/i, "Dead End"], [/^микрорайон$/i, "Microdistrict"], [/^мост$/i, "Bridge"], [/^дорога$/i, "Road"],
  [/^тракт$/i, "Tract"], [/^аллея$/i, "Alley"], [/^кольцо$/i, "Ring"], [/^путепровод$/i, "Overpass"], [/^развязка$/i, "Interchange"],
];
const ORD = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");

// «улица Лермонтова» -> «Lermontova Street», «1-я Железнодорожная улица» -> «1st Zheleznodorozhnaya Street»
export function streetEn(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  let type = "";
  const rest = words.filter((w) => {
    const hit = !type && STREET_TYPES.find(([re]) => re.test(w));
    if (hit) { type = hit[1]; return false; }
    return true;
  });
  const body = rest.map((w) => {
    const m = w.match(/^(\d+)-?(?:я|й|ая|ий|ой|е|го)$/i);
    return m ? ORD(Number(m[1])) : translit(w);
  }).join(" ");
  return type ? `${body} ${type}`.trim() : body;
}

// Название из тегов OSM на текущем языке: name:en, иначе латиницей
export function nameOf(tags: Record<string, string>): string {
  const ru = tags.name ?? "";
  if (current !== "en") return ru;
  return tags["name:en"] || (ru ? streetEn(ru) : "");
}
