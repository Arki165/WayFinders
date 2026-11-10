// Значки объектов на карте (SVG внутри программы, без загрузки из интернета)
import type { PoiKind } from "../model/poi";

export type IconKind = PoiKind | "signal";

const S = 64; // размер одного значка в атласе, пикселей
const wrap = (w: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${S}" viewBox="0 0 ${w} ${S}">${body}</svg>`;
const url = (svg: string) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
const letter = (bg: string, ch: string, round = false) =>
  `${round ? `<circle cx="32" cy="32" r="29" fill="${bg}" stroke="#fff" stroke-width="4"/>` : `<rect x="3" y="3" width="58" height="58" rx="10" fill="${bg}" stroke="#fff" stroke-width="4"/>`}<text x="32" y="45" font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#fff" text-anchor="middle">${ch}</text>`;

// Рисунок каждого значка в квадрате 64×64
const BODY: Record<IconKind, string> = {
  // светофор: корпус и три сигнала
  signal: `<rect x="17" y="2" width="30" height="60" rx="9" fill="#23272b" stroke="#fff" stroke-width="3"/><circle cx="32" cy="15" r="7" fill="#e5483f"/><circle cx="32" cy="32" r="7" fill="#e8b931"/><circle cx="32" cy="49" r="7" fill="#3fb265"/>`,
  // пешеходный переход: синий знак с белой «зеброй»
  crossing: `<rect x="3" y="3" width="58" height="58" rx="8" fill="#1f63c6" stroke="#fff" stroke-width="4"/><g fill="#fff"><rect x="13" y="16" width="6" height="32"/><rect x="24" y="16" width="6" height="32"/><rect x="35" y="16" width="6" height="32"/><rect x="46" y="16" width="6" height="32"/></g>`,
  bus: letter("#1f8a4c", "А"),
  tram: letter("#c2602a", "Т"),
  train: letter("#5d6670", "Ж"),
  metro: letter("#d7282f", "М", true),
  entrance: letter("#d7282f", "м", true),
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
