# @metator/desktop

MetatorAI Desktop (D7, ADR-0078): Vite + React in `src/`, wrapped by Tauri in `src-tauri/`, drawing what `metator serve` says. From `@metator/core` only types, as a whole-statement `import type` (ADR-0085); the daemon's shapes are typed in `src/shared/api/api.ts`.

- Layers (ADR-0109): `app/` → `features/<name>/` → `shared/` → `ui/`, never back. View logic is pure in `model.ts` files, tested in `test/`; components only render.
- State (ADR-0113): a zustand store per screen (`scopedStore`, `shared/state/`) in `features/<name>/state.ts`; a small part reads one value by selector, daemon data by `usePolledSelect`. No `useState`. Exemplar: `features/backlog/`.
- Reuse: `ui/` (`<Modal>`, `<Tabs>`, `<ListDetail>`), `usePolled`, `useAction` (`shared/hooks.ts`), `runControls`. `useDaemon("repo")` names the fields it reads. Sizes and colours are `:root` tokens in `src/styles.css`.
- Words: run, session (the live agent process), task (a backlog item), Terminals, Changes. A decision card's answer carries `origin: inbox` (acceptance 11a).
- Tauri only through `shared/platform/tauri-commands.ts` and its fake (ADR-0105); every screen works in a browser too. Rust: `cargo test` in `src-tauri`.
- `bun run build` makes `dist/`; the `e2e/desktop*.e2e.test.ts` build it, start the daemon and drive Chromium.
- Pitfall: `exactOptionalPropertyTypes`: optional props take `| undefined` explicitly.
