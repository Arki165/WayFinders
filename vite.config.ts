import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // относительные пути, чтобы собранная версия открывалась в Electron из файла
  base: "./",
  server: { port: 5173, strictPort: true },
  // MapLibre запускает свой фоновый поток, предсборка Vite его ломает
  optimizeDeps: { exclude: ["maplibre-gl"] },
  build: { chunkSizeWarningLimit: 3000 },
  worker: { format: "es" },
});
