/**
 * The repository switcher in the top bar (round 20): the repositories and folders the app knows,
 * the open one marked; "Add repository…"; "Remove from the app" for the open one (it forgets it,
 * its files stay). In a browser the app knows none: it names what the daemon serves, and Add
 * repository shows the commands to run. A dev container's repository reads "shop (Dev Container)",
 * with its container's state (round 21).
 */

import { useRef } from "react";
import { navigate } from "../../shared/navigation.ts";
import { ScopeProvider, useScopedApi } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { ContextMenu, type MenuItem } from "../../ui/context-menu.tsx";
import { repoName, switcherLabel, switcherRows } from "./repos.ts";
import { reposActs, useRepos } from "./repos-context.tsx";
import { Switcher, useSwitcher } from "./state.ts";

type Served = { readonly text: string; readonly repos: string[] };

export function RepoSwitcher({ served }: { readonly served: Served }) {
  return (
    <ScopeProvider store={Switcher} init={undefined}>
      <SwitcherButton served={served} />
    </ScopeProvider>
  );
}

function SwitcherButton({ served }: { readonly served: Served }) {
  const repos = useRepos();
  const api = useScopedApi(Switcher);
  const open = useSwitcher((s) => s.at !== undefined);
  // A press on the button closes the open menu (a press outside it): the click after must not open it again.
  const closed = useRef(0);
  const rows = switcherRows(repos.known ?? [], repos.current?.path, repos.states);
  return (
    <>
      <Button
        variant="ghost"
        className="scope switcher"
        data-testid="scope"
        aria-haspopup="menu"
        aria-expanded={open}
        title={served.repos.join("\n") || undefined}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (Date.now() - closed.current > 300) {
            api.getState().openAt({ x: r.left, y: r.bottom + 4 });
            // A dev container's state is read again each time the menu opens.
            if (rows.some((row) => row.kind === "devcontainer")) void repos.refreshContainers();
          }
        }}
      >
        {switcherLabel(repos.current, served.text)} ▾
      </Button>
      <Refusal />
      <SwitcherMenu
        served={served}
        onClose={() => {
          closed.current = Date.now();
          api.getState().close();
        }}
      />
    </>
  );
}

function Refusal() {
  const refusal = useSwitcher((s) => s.refusal);
  return refusal ? (
    <span className="refusal switcher-refusal" role="alert">
      {refusal}
    </span>
  ) : null;
}

function SwitcherMenu({ served, onClose }: { readonly served: Served; onClose(): void }) {
  const repos = useRepos();
  const at = useSwitcher((s) => s.at);
  const act = useSwitcher((s) => s.act);
  if (!at) return null;
  const rows = switcherRows(repos.known ?? [], repos.current?.path, repos.states);
  const items: MenuItem[] = [
    ...rows.map((r) => ({
      label: `${r.current ? "✓ " : ""}${r.name}${r.note ? ` · ${r.note}` : ""}`,
      onSelect: r.current ? undefined : () => act(reposActs.open(r.path)),
    })),
    ...(repos.commands ? [] : served.repos.map((name) => ({ label: name, disabled: true }))),
    {
      label: "Add repository…",
      separator: rows.length > 0 || served.repos.length > 0,
      onSelect: () => {
        navigate({ screen: "add" });
      },
    },
    ...(repos.current
      ? [
          {
            label: `Remove ${repoName(repos.current)} from the app`,
            onSelect: () => act(reposActs.remove(repos.current?.path ?? "")),
          },
        ]
      : []),
  ];
  return <ContextMenu at={at} items={items} label="repositories" onClose={onClose} />;
}
