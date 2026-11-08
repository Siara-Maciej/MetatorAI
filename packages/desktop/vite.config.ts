import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The desktop app's build: a static bundle Tauri wraps, or any browser opens next to `metator serve`. */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
