/**
 * A tab's panes laid out by its split tree (S6, herdr's splits): each node is a flex row or
 * column at its ratio, with a divider a person drags; a leaf is whatever the caller renders for
 * the pane. A zoomed pane fills the whole area.
 */
import { type ReactNode, useCallback, useRef } from "react";
import type { SplitNode } from "../api.ts";
import { withRatio } from "../model.ts";

export function SplitGrid({
  tree,
  zoom,
  renderPane,
  onResize,
}: {
  readonly tree: SplitNode;
  readonly zoom?: string | undefined;
  renderPane(paneId: string): ReactNode;
  /** The tree with one ratio changed, when a divider drag ends. */
  onResize(tree: SplitNode): void;
}) {
  const live = useRef<SplitNode>(tree);
  live.current = tree;
  const drag = useCallback(
    (path: readonly ("a" | "b")[], dir: "row" | "column", e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
      const move = (ev: MouseEvent) => {
        const ratio =
          dir === "row" ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
        live.current = withRatio(live.current, path, ratio);
        // Live feedback: the node's flex sizes follow the mouse.
        const parent = e.currentTarget.parentElement as HTMLElement;
        const r = Math.min(0.9, Math.max(0.1, ratio));
        (parent.children[0] as HTMLElement).style.flex = `${r} 1 0`;
        (parent.children[2] as HTMLElement).style.flex = `${1 - r} 1 0`;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        onResize(live.current);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [onResize],
  );
  if (zoom) return <div className="split zoomed">{renderPane(zoom)}</div>;
  const render = (node: SplitNode, path: ("a" | "b")[]): ReactNode => {
    if ("pane" in node) return renderPane(node.pane);
    return (
      <div className={`split ${node.dir}`} data-ratio={node.ratio}>
        <div className="part" style={{ flex: `${node.ratio} 1 0` }}>
          {render(node.a, [...path, "a"])}
        </div>
        <hr
          className={`divider ${node.dir}`}
          aria-orientation={node.dir === "row" ? "vertical" : "horizontal"}
          onMouseDown={(e) => drag(path, node.dir, e)}
        />
        <div className="part" style={{ flex: `${1 - node.ratio} 1 0` }}>
          {render(node.b, [...path, "b"])}
        </div>
      </div>
    );
  };
  return <>{render(tree, [])}</>;
}
