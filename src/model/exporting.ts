// Выгрузка таблиц и картинок в файлы через Electron (или скачивание в браузере)
import { useEditor } from "./store";
import { makeXlsx, type Sheet } from "./xlsx";

export function toCsv(header: (string | number)[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : typeof v === "number" ? String(v).replace(".", ",") : v;
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // точка с запятой и BOM, чтобы Excel сразу открыл кириллицу и дробные числа
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n");
}

function browserDownload(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function saveCsv(name: string, text: string) {
  if (window.api) {
    const p = await window.api.saveText(name, text, [{ name: "CSV", extensions: ["csv"] }]);
    if (p) useEditor.getState().toast("Сохранено: " + p);
  } else browserDownload(name, new Blob([text], { type: "text/csv" }));
}

export async function saveOsmText(name: string, text: string) {
  if (window.api) return window.api.saveText(name, text, [{ name: "OpenStreetMap", extensions: ["osm"] }]);
  browserDownload(name, new Blob([text], { type: "application/xml" }));
  return name;
}

export async function savePng(name: string, canvas: HTMLCanvasElement) {
  const url = canvas.toDataURL("image/png");
  if (window.api) {
    const p = await window.api.savePng(name, url.split(",")[1]);
    if (p) useEditor.getState().toast("Сохранено: " + p);
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  }
}

// Байты в base64 кусками: весь файл одной строкой браузер может не переварить
function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

// Таблица Excel: листы собирает makeXlsx в xlsx.ts
export async function saveXlsx(name: string, sheets: Sheet[]) {
  const bytes = makeXlsx(sheets);
  if (window.api) {
    const p = await window.api.saveBinary(name, toBase64(bytes), [{ name: "Excel", extensions: ["xlsx"] }]);
    if (p) useEditor.getState().toast("Сохранено: " + p);
  } else browserDownload(name, new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

// PDF из готовой страницы html. В программе печатает Electron, в браузере открывается окно печати
export async function savePdf(name: string, html: string) {
  if (window.api) {
    const p = await window.api.savePdf(name, html);
    if (p) useEditor.getState().toast("Сохранено: " + p);
  } else {
    const w = window.open("", "_blank");
    if (!w) return useEditor.getState().toast("Браузер не дал открыть окно печати");
    w.document.write(html);
    w.document.close();
    w.onload = () => w.print();
  }
}
