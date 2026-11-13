# @metator/desktop

MetatorAI Desktop (D7, ADR-0078): a Vite + React app in `src/`, wrapped by Tauri in `src-tauri/`, that only draws what `metator serve` says. It carries no MetatorAI code: from `@metator/core` it takes types only, with a whole-statement `import type` (ADR-0085, `bun run arch` checks it); what the daemon composes itself is typed in `src/api.ts`.

- View logic that the daemon does not do (panel order, feature groups, routes, times, what a state reads as, the counts, the workbench's commands) is pure in `src/model.ts`, tested in `test/`; components only render.
- Before writing markup or a request by hand, use what is shared: `<ListDetail>`/`<ListRow>`, `<RunHeader>`, `<StageBar>`, `<Glyph>`, `<Tabs>`, `<Modal>`, `<ActivityList>`; `usePolled`, `useAction`, `runControls`, `useOption` (`src/hooks.ts`). Sizes, gaps and colours are tokens of `:root` in `src/styles.css`.
- An answer from the decision card is sent with `origin: inbox`: that is what acceptance 11a counts. Keep it on that path only.
- `bun run build` makes `dist/`; `e2e/desktop.e2e.test.ts` builds it, starts the daemon and drives Chromium. `bun run tauri dev|build` needs Rust and the platform's webview (WebKitGTK on Linux).
- Pitfall: the root `tsconfig.json` typechecks this package with `exactOptionalPropertyTypes`; optional props take `| undefined` explicitly.
