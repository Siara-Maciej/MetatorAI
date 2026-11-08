import type { StageProgress } from "../api.ts";
import { stageGlyph } from "../model.ts";

/** `intake ✓ ─ plan ✓ ─ [build ⟳] ─ gates ·` */
export const StageBar = ({ stages }: { readonly stages: readonly StageProgress[] }) => (
  <ul className="stagebar" aria-label="stages">
    {stages.map((s, i) => (
      <li key={s.id}>
        {i > 0 ? <span className="dim"> ─ </span> : null}
        <span className={`st ${s.state}`}>
          {s.state === "current" ? `[${s.id} ${stageGlyph(s)}]` : `${s.id} ${stageGlyph(s)}`}
        </span>
      </li>
    ))}
  </ul>
);
