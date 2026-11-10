// Функции, которые Electron дает окну через preload.cjs
interface WayFindersApi {
  openOsm: () => Promise<{ name: string; path: string; text: string } | null>;
  saveText: (defaultName: string, text: string, filters: { name: string; extensions: string[] }[]) => Promise<string | null>;
  savePng: (defaultName: string, base64: string) => Promise<string | null>;
  saveBinary: (defaultName: string, base64: string, filters: { name: string; extensions: string[] }[]) => Promise<string | null>;
  savePdf: (defaultName: string, html: string) => Promise<string | null>;
  readExample: () => Promise<string>;
  writeFile:(filePath: string, text: string) => Promise<string>;
}

interface Window {
  api?: WayFindersApi;
}
