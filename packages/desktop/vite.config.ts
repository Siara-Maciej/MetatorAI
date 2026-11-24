import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The desktop app's build: a static bundle Tauri wraps, or any browser opens next to `metator serve`.
 * React Compiler (ADR-0109) memoizes components and hooks; `test/compiler.test.ts` checks that it
 * compiles all of them. Tailwind (ADR-0111) builds `src/ui/theme.css`.
 */
export default defineConfig({
  plugins: [react({ babel: { plugins: ["babel-plugin-react-compiler"] } }), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
