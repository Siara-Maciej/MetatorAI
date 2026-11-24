# @metator/desktop

MetatorAI Desktop (D7, ADR-0078): a Vite + React app in `src/`, wrapped by Tauri in `src-tauri/`, that draws what `metator serve` says. From `@metator/core` it takes types only, as a whole-statement `import type` (ADR-0085); what the daemon composes is typed in `src/api.ts`.

- View logic the daemon does not do (order, routes, times, state words, counts, workbench commands) is pure in `src/model.ts`, tested in `test/`; components only render.
- Use what is shared: `<ListDetail>`, `<RunHeader>`, `<Tabs>`, `<Modal>`; `usePolled`, `useAction`, `runControls` (`src/hooks.ts`). `useDaemon("repo")` names the fields it reads. Sizes and colours are `:root` tokens in `src/styles.css`.
- One sidebar and one place (`src/app.tsx`); a run is one page with tabs (`src/screens/run.tsx`, `src/run/`). Words: run, session (the live agent process only), task (a backlog item only), Terminals, Changes.
- A decision card's answer carries `origin: inbox` (acceptance 11a counts it); keep it on that path only.
- The Tauri shell only through `src/tauri-commands.ts` and its fake; Add repository is pure in `src/repos.ts` (ADR-0105). Every screen must work in a browser too. Rust: `cargo test` in `src-tauri`.
- `bun run build` makes `dist/`; `e2e/desktop.e2e.test.ts` builds it, starts the daemon and drives Chromium. `bun run tauri dev|build` needs Rust and a webview.
- Pitfall: the root `tsconfig.json` uses `exactOptionalPropertyTypes`; optional props take `| undefined` explicitly.
