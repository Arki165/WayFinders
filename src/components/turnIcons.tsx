// Стрелки поворотов для полос в SVG: одна картинка на набор поворотов («налево и прямо» и т.п.).
// Сетка 64×64, стрелка снизу вверх (вверх - прямо по ходу полосы). Цвет - currentColor или маска на карте.

// Ствол стрелки и наконечник для каждого поворота
const PARTS: Record<string, { line: string; head: string }> = {
  through: { line: "M32 60V14", head: "M22 18L32 4L42 18Z" },
  left: { line: "M32 60V34Q32 26 24 26H16", head: "M18 16L4 26L18 36Z" },
  right: { line: "M32 60V34Q32 26 40 26H48", head: "M46 16L60 26L46 36Z" },
  slight_left: { line: "M32 60V38L18 20", head: "M11 26L12 10L27 15Z" },
  slight_right: { line: "M32 60V38L46 20", head: "M53 26L52 10L37 15Z" },
  reverse: { line: "M32 60V26A9 9 0 0 0 14 26V38", head: "M6 36L14 50L22 36Z" },
};
// похожие повороты рисуем так же
const ALIAS: Record<string, string> = { sharp_left: "left", sharp_right: "right", merge_to_left: "slight_left", merge_to_right: "slight_right" };

const parts = (turn: string) => [...new Set(turn.split(";").map((t) => ALIAS[t] ?? t))].filter((t) => PARTS[t]).map((t) => PARTS[t]);

// Содержимое SVG для набора поворотов (без обертки <svg>)
export function turnBody(turn: string, color = "currentColor"): string {
  return parts(turn).map((p) => `<path d="${p.line}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="${p.head}" fill="${color}" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`).join("");
}

// Картинка для слоя карты (белая, цвет задает маска слоя)
export function turnIconUrl(turn: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${turnBody(turn, "#fff")}</svg>`);
}

// «А» на автобусной полосе тоже рисунком: буква из линий, без шрифта
export const BUS_LETTER_URL = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M14 58L32 6L50 58M21 40H43" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>');

// Стрелка в интерфейсе (кнопки поворотов, схема полос)
export function TurnIcon({ turn, size = 16 }: { turn: string; size?: number }) {
  if (!parts(turn).length) return null;
  return <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" dangerouslySetInnerHTML={{ __html: turnBody(turn) }} />;
}

// Стрелка направления полосы: вверх - туда, вниз - обратно
export function DirIcon({ back, size = 14 }: { back?: boolean; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={back ? { transform: "rotate(180deg)" } : undefined} dangerouslySetInnerHTML={{ __html: turnBody("through") }} />;
}
