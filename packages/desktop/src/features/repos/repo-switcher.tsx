/**
 * The repository switcher in the top bar (round 20): the repositories and folders the app knows,
 * the open one marked; "Add repository…"; "Remove from the app" for the open one (it forgets it,
 * its files stay). In a browser the app knows none: it names what the daemon serves, and Add
 * repository shows the commands to run. A dev container's repository reads "shop (Dev Container)",
 * with its container's state (round 21).
 */

import { useRef, useState } from "react";
import { navigate } from "../../shared/navigation.ts";
import { ContextMenu, type MenuItem } from "../../ui/context-menu.tsx";
import { repoName, switcherLabel, switcherRows } from "./repos.ts";
import { useRepos } from "./repos-context.tsx";

export function RepoSwitcher({
  served,
}: {
  readonly served: { readonly text: string; readonly repos: string[] };
}) {
  const repos = useRepos();
  const [at, setAt] = useState<{ x: number; y: number }>();
  // A press on the button closes the open menu (a press outside it): the click after must not open it again.
  const closed = useRef(0);
  const [refusal, setRefusal] = useState<string>();
  const rows = switcherRows(repos.known ?? [], repos.current?.path, repos.states);
  const act = (p: Promise<string | undefined>) => {
    setRefusal(undefined);
    void p.then((why) => setRefusal(why));
  };
  const items: MenuItem[] = [
    ...rows.map((r) => ({
      label: `${r.current ? "✓ " : ""}${r.name}${r.note ? ` · ${r.note}` : ""}`,
      onSelect: r.current ? undefined : () => act(repos.open(r.path)),
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
            onSelect: () => act(repos.remove(repos.current?.path ?? "")),
          },
        ]
      : []),
  ];
  return (
    <>
      <button
        type="button"
        className="ghost scope switcher"
        data-testid="scope"
        aria-haspopup="menu"
        aria-expanded={at !== undefined}
        title={served.repos.join("\n") || undefined}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (Date.now() - closed.current > 300) {
            setAt({ x: r.left, y: r.bottom + 4 });
            // A dev container's state is read again each time the menu opens.
            if (rows.some((row) => row.kind === "devcontainer")) void repos.refreshContainers();
          }
        }}
      >
        {switcherLabel(repos.current, served.text)} ▾
      </button>
      {refusal ? (
        <span className="refusal switcher-refusal" role="alert">
          {refusal}
        </span>
      ) : null}
      {at ? (
        <ContextMenu
          at={at}
          items={items}
          label="repositories"
          onClose={() => {
            closed.current = Date.now();
            setAt(undefined);
          }}
        />
      ) : null}
    </>
  );
}
