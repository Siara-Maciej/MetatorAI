# @metator/desktop

MetatorAI Desktop (D7, ADR-0078): a Vite + React app in `src/`, wrapped by Tauri in `src-tauri/`, that draws what `metator serve` says. From `@metator/core` it takes types only, with a whole-statement `import type` (ADR-0085, `bun run arch` checks it); what the daemon composes itself is typed in `src/api.ts`.

- View logic the daemon does not do (order, routes, times, state words, counts, workbench commands) is pure in `src/model.ts`, tested in `test/`; components only render.
- Use what is shared before writing markup or a request: `<ListDetail>`, `<RunHeader>`, `<StageBar>`, `<Glyph>`, `<Tabs>`, `<Modal>`, `<ActivityList>`; `usePolled`, `useAction`, `runControls`, `useOption` (`src/hooks.ts`). Sizes, gaps and colours are `:root` tokens in `src/styles.css`.
- The shell is one sidebar and one place (`src/app.tsx`, `src/components/sidebar.tsx`); a run is one page with tabs (`src/screens/run.tsx`, `src/run/`); Overview is `src/screens/overview.tsx`. Words: run, session (the live agent process only), task (a backlog item only), Terminals, Changes.
- An answer from the decision card is sent with `origin: inbox`: that is what acceptance 11a counts. Keep it on that path only.
- `bun run build` makes `dist/`; `e2e/desktop.e2e.test.ts` builds it, starts the daemon and drives Chromium. `bun run tauri dev|build` needs Rust and the platform's webview.
- Pitfall: the root `tsconfig.json` uses `exactOptionalPropertyTypes`; optional props take `| undefined` explicitly.
