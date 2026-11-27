/**
 * The Backlog's new-task form (ADR-0113): each field reads only its own part of the draft, so
 * typing a title draws the title field again, not the form or the screen. Add and Cancel act on
 * the Backlog store at the moment of the click.
 */
import type { Issue } from "../../shared/api/api.ts";
import { issueRefText } from "../../shared/model/format.ts";
import { Button } from "../../ui/button.tsx";
import { type TaskDraft, useBacklog, useBacklogApi } from "./state.ts";

export function NewTaskForm() {
  const api = useBacklogApi();
  return (
    <form
      className="form"
      aria-label="a new task"
      onSubmit={(e) => {
        e.preventDefault();
        void api.getState().add();
      }}
      onKeyDown={(e) => {
        // Escape leaves the form as Cancel does.
        if (e.key === "Escape") {
          e.preventDefault();
          api.getState().closeForm();
        }
      }}
    >
      <div className="dim">a new task · yours</div>
      <TitleField />
      <BodyField />
      <div className="row">
        <PriorityField />
        <LabelsField />
      </div>
      <DraftRefs />
      <div className="actions">
        <Button type="submit" variant="primary">
          Add
        </Button>
        <Button onClick={() => api.getState().closeForm()}>Cancel</Button>
      </div>
    </form>
  );
}

/** One field of the draft: what it shows and how it changes it. */
function useDraftField<K extends keyof TaskDraft>(field: K): [TaskDraft[K], (value: TaskDraft[K]) => void] {
  const value = useBacklog((s) => s.draft[field]);
  const edit = useBacklog((s) => s.edit);
  return [value, (v) => edit(field, v)];
}

export function TitleField() {
  const [title, setTitle] = useDraftField("title");
  return (
    <label>
      <span className="dim">title</span>
      <input
        // biome-ignore lint/a11y/noAutofocus: the form opens on a click; the title is where typing goes
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
    </label>
  );
}

export function BodyField() {
  const [body, setBody] = useDraftField("body");
  return (
    <label>
      <span className="dim">what and why</span>
      <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
    </label>
  );
}

function PriorityField() {
  const [priority, setPriority] = useDraftField("priority");
  return (
    <label>
      <span className="dim">priority</span>
      <select
        aria-label="priority"
        value={priority}
        onChange={(e) => setPriority(e.target.value as Issue["priority"])}
      >
        <option value="low">low</option>
        <option value="normal">normal</option>
        <option value="high">high</option>
      </select>
    </label>
  );
}

export function LabelsField() {
  const [labels, setLabels] = useDraftField("labels");
  return (
    <label>
      <span className="dim">labels</span>
      <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="billing, tests" />
    </label>
  );
}

/** What a draft from "New task from here…" points at. */
function DraftRefs() {
  const refs = useBacklog((s) => s.refs);
  return refs.length > 0 ? <div className="dim">points at: {refs.map(issueRefText).join(" · ")}</div> : null;
}
