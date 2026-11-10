// Значки объектов на карте (SVG внутри программы, без загрузки из интернета)
import type { PoiKind } from "../model/poi";

export type IconKind = PoiKind | "signal";

const S = 64; // размер одного значка в атласе, пикселей
const wrap = (w: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${S}" viewBox="0 0 ${w} ${S}">${body}</svg>`;
const url = (svg: string) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
// Подложка значка: скругленный квадрат или круг цвета вида транспорта с белой каймой
const square = (bg: string) => `<rect x="3" y="3" width="58" height="58" rx="12" fill="${bg}" stroke="#fff" stroke-width="4"/>`;
const circle = (bg: string, r = 29) => `<circle cx="32" cy="32" r="${r}" fill="${bg}" stroke="#fff" stroke-width="4"/>`;
// Вагон спереди: корпус, лобовое стекло цвета подложки, фары и колеса
const front = (bg: string, top: number) =>
  `<rect x="17" y="${top}" width="30" height="${44 - top}" rx="6" fill="#fff"/><rect x="21" y="${top + 4}" width="22" height="${Math.max(8, 22 - top)}" rx="2.5" fill="${bg}"/>` +
  `<circle cx="23" cy="38" r="2.6" fill="${bg}"/><circle cx="41" cy="38" r="2.6" fill="${bg}"/><rect x="19" y="44" width="7" height="7" rx="2" fill="#fff"/><rect x="38" y="44" width="7" height="7" rx="2" fill="#fff"/>`;
// Буква «М» метро линиями, без шрифта: на любом компьютере выглядит одинаково
const metroM = (w: number) => `<path d="M17 44V21L32 37L47 21V44" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

// Рисунок каждого значка в квадрате 64×64, все в SVG
const BODY: Record<IconKind, string> = {
  // светофор: корпус и три сигнала
  signal: `<rect x="17" y="2" width="30" height="60" rx="9" fill="#23272b" stroke="#fff" stroke-width="3"/><circle cx="32" cy="15" r="7" fill="#e5483f"/><circle cx="32" cy="32" r="7" fill="#e8b931"/><circle cx="32" cy="49" r="7" fill="#3fb265"/>`,
  // пешеходный переход: синий знак, треугольник и человек на «зебре»
  crossing: `${square("#1f63c6")}<path d="M32 9L55 52H9Z" fill="#fff"/><g fill="#1f63c6"><circle cx="33" cy="22" r="3.6"/><path d="M31 27l-5 9 3 1.5 3-5 2 6-4 9h4l3.5-7 3.5 5h4l-5-8-2-7 3 3h4l-5-5.5z"/><rect x="15" y="47" width="5" height="3"/><rect x="24" y="47" width="5" height="3"/><rect x="35" y="47" width="5" height="3"/><rect x="44" y="47" width="5" height="3"/></g>`,
  // автобус спереди
  bus: `${square("#1f8a4c")}${front("#1f8a4c", 12)}`,
  // трамвай спереди с токоприемником
  tram: `${square("#c2602a")}<path d="M24 8H40M32 8L27 17" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>${front("#c2602a", 17)}`,
  // поезд спереди: скругленная кабина и рельсы
  train: `${square("#5d6670")}<path d="M17 44V24a15 13 0 0 1 30 0v20z" fill="#fff"/><rect x="22" y="20" width="20" height="9" rx="2.5" fill="#5d6670"/><circle cx="24" cy="37" r="2.6" fill="#5d6670"/><circle cx="40" cy="37" r="2.6" fill="#5d6670"/><path d="M22 47l-5 8M42 47l5 8M20 52h24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`,
  metro: `${circle("#d7282f")}${metroM(6)}`,
  // вход в метро: «М» тоньше и стрелка внутрь
  entrance: `${circle("#d7282f")}${metroM(4.5)}<path d="M26 53h12M33 49l4 4-4 4" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
};

const KINDS = Object.keys(BODY) as IconKind[];

// Отдельные картинки - для панели «Слои»
export const ICONS = Object.fromEntries(KINDS.map((k) => [k, url(wrap(S, BODY[k]))])) as Record<IconKind, string>;

// Все значки одной картинкой в ряд. Если отдавать deck.gl значки по одному, он догружает их
// в атлас на ходу и при нескольких разных значках в одном слое один иногда терялся («М» пропадала).
export const ICON_ATLAS = url(wrap(S * KINDS.length, KINDS.map((k, i) => `<g transform="translate(${i * S},0)">${BODY[k]}</g>`).join("")));
// Атлас один раз рисуем из SVG в PNG: сам deck.gl SVG по адресу открыть не умеет.
// Рисуем в 2 раза крупнее, чтобы значки были четкими на экранах с масштабом 150-200%.
let atlas: Promise<string> | null = null;
export function loadIconAtlas(): Promise<string> {
  atlas ??= new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = S * KINDS.length * 2;
      cv.height = S * 2;
      cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
      ok(cv.toDataURL("image/png"));
    };
    img.onerror = () => bad(new Error("Не удалось нарисовать значки карты"));
    img.src = ICON_ATLAS;
  });
  return atlas;
}
export const ICON_MAPPING_2X = Object.fromEntries(KINDS.map((k, i) => [k, { x: i * S * 2, y: 0, width: S * 2, height: S * 2, mask: false }]));
export const ICON_MAPPING = Object.fromEntries(KINDS.map((k, i) => [k, { x: i * S, y: 0, width: S, height: S, mask: false }]));

export const ICON_TITLES: Record<IconKind, string> = {
  signal: "Светофор",
  crossing: "Пешеходный переход",
  bus: "Остановка автобуса",
  tram: "Остановка трамвая",
  train: "Станция, платформа",
  metro: "Станция метро",
  entrance: "Вход в метро",
};
