// Иконки программы. Все рисуются в SVG одним стилем: сетка 24×24, линия 1.8, скругленные концы,
// цвет берется от текста (currentColor), поэтому иконка сама подходит к светлой и темной теме.
// Новую иконку добавлять сюда, в ICONS, и рисовать в том же стиле (см. DESIGN.md).

const ICONS = {
  // инструменты слева
  select: <path d="M5 3.5l5.8 16.2 2.3-6.6 6.6-2.3z" />,
  draw: <><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  node: <><path d="M3 18L21 6" /><circle cx="11" cy="12.7" r="3" /><path d="M18 14v6M15 17h6" /></>,
  join: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  unjoin: <><path d="M12 6.5l1.5-1.5a3.9 3.9 0 0 1 5.5 5.5L17.5 12" /><path d="M12 17.5L10.5 19A3.9 3.9 0 0 1 5 13.5L6.5 12" /><path d="M4 4l2 2M20 20l-2-2M9 2.5V5M15 21.5V19" /></>,
  signal: <><rect x="8" y="2.5" width="8" height="19" rx="3" /><circle cx="12" cy="7" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="17" r="1.5" /></>,
  split: <><circle cx="6" cy="6" r="2.8" /><circle cx="6" cy="18" r="2.8" /><path d="M8.3 7.7L20 18M8.3 16.3L20 6" /></>,
  trash: <><path d="M4 7h16M9.5 7V4h5v3M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5" /></>,
  // верхняя панель
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  addMap: <><path d="M12 3L3 8l9 5 9-5z" /><path d="M3 13l9 5 3.5-2" /><path d="M19 14v6M16 17h6" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></>,
  save: <><path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2z" /><path d="M8 3v5h7V3M7.5 21v-6.5h9V21" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.3-4.3" /></>,
  gauge: <><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l3.5-6" /><path d="M7.5 12.5l1 .8M12 8.5V10M16.5 12.5l-1 .8" /></>,
  building: <><path d="M4 21V8l6-4v17M10 21V10h10v11M2.5 21h19" /><path d="M13.5 13.5h3M13.5 17h3M6.5 11h1M6.5 14.5h1" /></>,
  diff: <><path d="M12 20h8.5" /><path d="M16.5 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5 3.5 19.5l1-4z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />,
  // стрелки и мелкие знаки
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  fitAll: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  alert: <path d="M12 6v8M12 18v.5" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  arrowRight: <path d="M4 12h16M14 6l6 6-6 6" />,
  arrowLeft: <path d="M20 12H4M10 6l-6 6 6 6" />,
  twoWay: <path d="M4 8h15M15.5 4.5L19 8l-3.5 3.5M20 16H5M8.5 12.5L5 16l3.5 3.5" />,
  reverse: <path d="M17 3.5l3 3-3 3M20 6.5H9a4.5 4.5 0 0 0-4.5 4.5M7 20.5l-3-3 3-3M4 17.5h11a4.5 4.5 0 0 0 4.5-4.5" />,
  swap: <path d="M8 20V4M4.5 7.5L8 4l3.5 3.5M16 4v16M12.5 16.5L16 20l3.5-3.5" />,
  // шаблоны-вставки
  bridge: <><path d="M2 8h20M5 8v12M19 8v12" /><path d="M5 18.5c3.5-6 10.5-6 14 0" /></>,
  layers: <><path d="M12 3.5l9 4.5-9 4.5-9-4.5z" /><path d="M3 12.5l9 4.5 9-4.5" /><path d="M3 16.5l9 4.5 9-4.5" /></>,
  roundabout: <><circle cx="12" cy="12" r="4.5" /><path d="M12 2v5.5M12 16.5V22M2 12h5.5M16.5 12H22" /></>,
  uturn: <><path d="M7 21V10a5 5 0 0 1 10 0v6" /><path d="M13.5 13l3.5 3.5 3.5-3.5" /></>,
  turnLeft: <><path d="M18 21v-7a4 4 0 0 0-4-4H5" /><path d="M9 6l-4 4 4 4" /></>,
  turnRight: <><path d="M6 21v-7a4 4 0 0 1 4-4h9" /><path d="M15 6l4 4-4 4" /></>,
  bookmark: <><path d="M6 3.5h12V21l-6-4-6 4z" /><path d="M12 7.5v5M9.5 10h5" /></>,
  // улица: две кромки дороги и прерывистая осевая
  road: <><path d="M7 21L10 3M17 21L14 3" /><path d="M12 5v2.5M12 11v2.5M12 17v2.5" /></>,
  // остановка: табличка на столбе
  stop: <><rect x="6" y="3" width="12" height="9" rx="2" /><path d="M12 12v9M9 21h6M9.5 7.5h5" /></>,
};

export type IconName = keyof typeof ICONS;

// Знак Wayfinder: буква W, нарисованная как граф дорог. Тот же рисунок, что public/icon.svg (значок программы).
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#1d2630" />
      <path d="M11 19 L22 45 L32 26 L42 45 L53 19" fill="none" stroke="#35c2a4" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="19" r="5" fill="#1d2630" stroke="#fff" strokeWidth="3" />
      <circle cx="22" cy="45" r="3.6" fill="#fff" />
      <circle cx="32" cy="26" r="3.6" fill="#fff" />
      <circle cx="42" cy="45" r="3.6" fill="#fff" />
      <circle cx="53" cy="19" r="5" fill="#fff" />
    </svg>
  );
}

export default function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={"icon" + (className ? " " + className : "")} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
