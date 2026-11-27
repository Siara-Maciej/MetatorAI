/**
 * The decision card (screen 1, spec §6.3): everything a person needs to answer without opening
 * the session, composed by the daemon; the app only draws it and sends the answer back.
 *
 * What is chosen and written is the Answer store (ADR-0113, `answer-state.ts`): an option, the
 * reason field, the send button and the command line each read only their own piece, so typing
 * the person's words draws the field (and the command it writes), not the card.
 */

import { useEffect, useRef } from "react";
import type { InboxItem } from "../../shared/api/api.ts";
import { CommandText, commandOf } from "../../shared/components/command-text.tsx";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { hostPromptOf, humanPrompt, isTerminalQuestion, paneOfQuestion } from "../../shared/model/needs.ts";
import { isFinished } from "../../shared/model/runs.ts";
import { askWhy, consentOf } from "../../shared/model/stage1.ts";
import { groupStepText, systemPlanOf } from "../../shared/model/system-plans.ts";
import { Button } from "../../ui/button.tsx";
import { AskForChanges, lintRequest, RunPlanFull, SystemPlanFull } from "../plans/plan-approval-line.tsx";
import { isPublishGate, NOT_PUBLISHED } from "../reviews/model.ts";
import { ArtifactViewer } from "../runs/artifact-viewer.tsx";
import { AnswerError, AnswerScope, reasonFor } from "./answer.tsx";
import { chosenOf, readyOf, reasonOf, type SendOptions, useAnswer, useAnswerApi } from "./answer-state.ts";
import { CardDetails } from "./card-details.tsx";
import { optionClosed } from "./model.ts";

export function DecisionCard({
  item,
  onAnswered,
  onRefused,
  onOpenSession,
  onOpenChanges,
}: {
  readonly item: InboxItem;
  onAnswered(choices: readonly string[]): void;
  /** The daemon refused the answer (a person answers in the pane meanwhile): said where it stays. */
  onRefused?: ((message: string) => void) | undefined;
  onOpenSession(runId: string): void;
  /** The run's change, straight from the card: what the decision is about. */
  onOpenChanges(runId: string): void;
}) {
  const {
    client,
    systemPlans,
    run: runOf,
    runs,
    planStepsOf,
    stepPlaceOf,
    panes,
  } = useDaemon("client", "systemPlans", "run", "runs", "planStepsOf", "stepPlaceOf", "panes");
  const q = item.question;
  // A gate's card about the plan shows the plan's lint and the way to read or change it.
  const plan = usePolled(
    `card-plan:${item.repo ?? ""}:${q.runId}:${q.id}`,
    () =>
      q.source === "gate"
        ? client.runPlan(q.runId, item.repo)
        : Promise.resolve({ ok: false, error: { code: "NONE", message: "" } }),
    q.source === "gate" ? 5000 : 0,
  );
  const owner = runOf(q.runId, item.repo);
  const groupText = (g: { readonly parent: string; readonly step: number; readonly of: number }) => {
    // The parent can live in another repository (a system run's step).
    const parent = runOf(g.parent, item.repo) ?? runs.find((r) => r.runId === g.parent);
    return groupStepText(
      g,
      parent ? planStepsOf(parent) : undefined,
      parent ? isFinished(parent) : false,
      stepPlaceOf(q.runId),
    );
  };
  const systemPlan = owner ? systemPlanOf(systemPlans, owner, runs) : undefined;
  const planView =
    plan.data?.plan && (plan.data.question === q.id || plan.data.approvalStage === q.stage)
      ? plan.data
      : undefined;
  const card = q.card;
  // A host's prompt in a pane reads as its question, with who asks and the answers it offered.
  const host = q.source === "permission" ? hostPromptOf(q.prompt) : undefined;
  // A question the agent asks on its terminal: its words; an answer chosen here is typed in its pane.
  const terminal = isTerminalQuestion(q);
  const askPane = terminal ? paneOfQuestion(q, panes) : undefined;
  const heading = host?.text || humanPrompt(q.prompt);
  // A commit, push, merge or rebase the guard lets through only with the person's consent.
  const consent =
    q.source === "permission" ? consentOf({ prompt: heading, command: commandOf(q) }) : undefined;
  // The guard's own reason, when the host shows one (a commit that holds debug changes).
  const why = q.source === "permission" ? askWhy({ prompt: heading, command: commandOf(q) }) : undefined;
  // A plan with lint errors closes Approve: the daemon says so on the option, or the lint does.
  const lintOfPlan =
    planView?.lint ??
    (q.source === "gate" && systemPlan && (systemPlan.status === "draft" || systemPlan.approval?.stale)
      ? systemPlan.lint
      : undefined);
  const closed = new Map(
    q.options.flatMap((o) => {
      const why = optionClosed(o, lintOfPlan);
      return why ? [[o.label, why] as const] : [];
    }),
  );
  const open = q.options.filter((o) => !closed.has(o.label));
  // A review's publish (round 18): one Yes/No for the whole review, Yes the gate's Approve, No its Reject.
  const publish =
    isPublishGate(q) && ["Approve", "Reject"].every((l) => q.options.some((o) => o.label === l));
  // A plan's approval: the plan in full on the card, and "Ask for changes" in place of Reject.
  const planGate =
    !publish &&
    q.source === "gate" &&
    (planView !== undefined || systemPlan !== undefined) &&
    q.options.some((o) => o.label === "Reject");
  // On a plan's approval, Reject and Other are both "in your own words": Ask for changes carries them.
  const askedInWords = (label: string) => planGate && (label === "Reject" || label === "Other");
  // The recommended option is chosen first; nothing is chosen for the person when it is closed
  // (the next one may be a Reject that needs a reason), and a multi-select starts empty.
  const first =
    card?.recommended !== undefined
      ? closed.has(card.recommended)
        ? undefined
        : card.recommended
      : open[0]?.label;
  // What a send does once the daemon answered: the card's own callbacks, read at the send.
  const done: Pick<SendOptions, "onDone" | "onRefused"> = { onDone: onAnswered, onRefused };
  // The options on the card's face: on a plan's approval only Approve, sent by the button itself.
  const faceOptions = q.options.filter((o) => !askedInWords(o.label));
  const onlyApprove = planGate && faceOptions.every((o) => o.label === "Approve");
  // One set of controls everywhere a decision is shown (Home's): the options are the choice and
  // one button sends it; Reject and Other ask for their reason inline. On a plan's approval the
  // two actions (Approve, Ask for changes) stand above the plan, so they are seen first.
  const actions = publish ? (
    <PublishYesNo approveClosed={closed.get("Approve")} done={done} />
  ) : (
    <>
      <div className="actions">
        <SendButton done={done} />
      </div>
      {planGate ? (
        <AskForChangesOf
          blocked={closed.get("Approve")}
          lintText={lintRequest(lintOfPlan?.problems ?? [])}
          done={done}
        />
      ) : null}
    </>
  );
  return (
    <AnswerScope
      question={q}
      repo={item.repo}
      initial={q.multiSelect || !first ? [] : [first]}
      origin="inbox"
    >
      <EnterSends done={done} />
      <article className="card" aria-label="decision card">
        <h1 className={heading.length > 160 ? "long" : undefined}>
          {/* A host's question names its command: its start, a click for the whole (round 11). */}
          {q.source === "permission" || commandOf(q) ? (
            <CommandText prompt={heading} command={commandOf(q)} />
          ) : (
            heading
          )}
        </h1>
        {terminal || host ? (
          <div className="muted" data-testid="host-asker">
            {host?.asker ?? q.agent ?? "the agent"} asks on its terminal
            {terminal ? " · an answer chosen here is typed there for you" : ""}
          </div>
        ) : null}
        {why ? (
          <div className="consent" data-testid="ask-why">
            {why}
          </div>
        ) : null}
        {consent ? (
          <div className="consent amber" data-testid="consent">
            {consent.text}
          </div>
        ) : null}
        {planGate ? (
          <div className="decide-bar" data-testid="decide-bar">
            {actions}
          </div>
        ) : null}
        {planView ? (
          <RunPlanFull view={planView} runId={owner?.parent ? undefined : q.runId} repo={item.repo} />
        ) : null}
        {!planView && systemPlan && q.source === "gate" ? (
          <SystemPlanFull plan={systemPlan} runId={q.runId} />
        ) : null}
        {onlyApprove || publish ? null : (
          <section>
            {q.multiSelect ? <h3>Choose one or more</h3> : null}
            <fieldset className="options">
              <legend className="dim">options</legend>
              {faceOptions.map((o) => (
                <OptionButton
                  key={o.label}
                  label={o.label}
                  description={o.description}
                  closedWhy={closed.get(o.label)}
                  recommended={card?.recommended === o.label}
                />
              ))}
            </fieldset>
            {planGate
              ? null
              : [...closed].map(([label, why]) => (
                  <div key={label} className="closed-option" data-testid="closed-option">
                    <span className="red">
                      {label} is closed: {why}.
                    </span>
                  </div>
                ))}
          </section>
        )}
        <ReasonField done={done} />
        {planGate ? null : actions}
        <AnswerError />
        <CardDetails
          item={item}
          askPane={askPane}
          host={host}
          groupText={groupText}
          done={done}
          onOpenChanges={onOpenChanges}
          onOpenSession={onOpenSession}
        />
        <Viewing runId={q.runId} repo={item.repo} />
      </article>
    </AnswerScope>
  );
}

type Done = Pick<SendOptions, "onDone" | "onRefused">;

/** Enter sends the selected answer (the ⏎ on the button), unless a field or a button has the key. */
function EnterSends({ done }: { readonly done: Done }) {
  const api = useAnswerApi();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || !readyOf(api.getState())) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLButtonElement ||
        e.target instanceof HTMLAnchorElement
      )
        return;
      e.preventDefault();
      void api.getState().send(done);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return null;
}

/** A review's publish (round 18): one Yes/No for the whole review, Yes the gate's Approve, No its Reject. */
function PublishYesNo({
  approveClosed,
  done,
}: {
  readonly approveClosed: string | undefined;
  readonly done: Done;
}) {
  const busy = useAnswer((s) => s.busy);
  const api = useAnswerApi();
  return (
    <div className="actions" data-testid="publish-yes-no">
      <Button
        variant="primary"
        disabled={busy || approveClosed !== undefined}
        title={approveClosed}
        onClick={() => void api.getState().send({ ...done, picked: ["Approve"] })}
      >
        Yes
      </Button>
      <Button
        disabled={busy}
        onClick={() => void api.getState().send({ ...done, picked: ["Reject"], words: NOT_PUBLISHED })}
      >
        No
      </Button>
    </div>
  );
}

/** The button that sends what is chosen: it draws again when the choice or the readiness changes. */
function SendButton({ done }: { readonly done: Done }) {
  const ready = useAnswer(readyOf);
  const reason = useAnswer(reasonOf);
  const chosen = useAnswer(chosenOf);
  const api = useAnswerApi();
  return (
    <Button
      variant="primary"
      disabled={!ready}
      title={reason && !ready ? "write the reason first" : undefined}
      onClick={() => void api.getState().send(done)}
    >
      {chosen !== "" ? chosen : "Choose"} ⏎
    </Button>
  );
}

/** A plan's approval: "Ask for changes" carries the person's words as the Reject. */
function AskForChangesOf({
  blocked,
  lintText,
  done,
}: {
  readonly blocked: string | undefined;
  readonly lintText: string;
  readonly done: Done;
}) {
  const busy = useAnswer((s) => s.busy);
  const api = useAnswerApi();
  return (
    <AskForChanges
      blocked={blocked}
      lintText={lintText}
      busy={busy}
      onSend={(words) => void api.getState().send({ ...done, picked: ["Reject"], words })}
    />
  );
}

/** One option on the card's face: it hears only whether it is chosen. */
export function OptionButton({
  label,
  description,
  closedWhy,
  recommended,
}: {
  readonly label: string;
  readonly description?: string | undefined;
  /** Why the option is closed (a plan with lint errors closes Approve). */
  readonly closedWhy: string | undefined;
  readonly recommended: boolean;
}) {
  const pressed = useAnswer((s) => s.choices.includes(label));
  const toggle = useAnswer((s) => s.toggle);
  return (
    <Button
      className="option"
      aria-pressed={pressed}
      disabled={closedWhy !== undefined}
      title={closedWhy ?? description}
      onClick={() => toggle(label)}
    >
      <span className="label">
        <span>{label}</span>
        {recommended ? <span className="rec">RECOMMENDED</span> : null}
      </span>
      {closedWhy !== undefined ? <span className="cons red">closed: the reason is below</span> : null}
    </Button>
  );
}

/** Reject or Other chosen: the field for the reason it asks for. */
export function ReasonField({ done }: { readonly done: Done }) {
  const reason = useAnswer(reasonOf);
  return reason ? <ReasonInput done={done} /> : null;
}

function ReasonInput({ done }: { readonly done: Done }) {
  const forWhat = useAnswer(reasonFor);
  const text = useAnswer((s) => s.text);
  const setText = useAnswer((s) => s.setText);
  const api = useAnswerApi();
  const field = useRef<HTMLInputElement>(null);
  // The field appears because Reject or Other was chosen: the cursor goes to it.
  useEffect(() => {
    field.current?.focus();
  }, []);
  return (
    <label className="reason">
      <span className="amber">{`Reason for ${forWhat} (required)`}</span>
      <input
        ref={field}
        aria-label="reason (required)"
        placeholder="the run gets your words; say what must change"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && readyOf(api.getState())) void api.getState().send(done);
        }}
      />
    </label>
  );
}

/** The artifact of the run the person opened from the card's Details. */
function Viewing({ runId, repo }: { readonly runId: string; readonly repo: string | undefined }) {
  const viewing = useAnswer((s) => s.viewing);
  const view = useAnswer((s) => s.view);
  return viewing ? (
    <ArtifactViewer runId={runId} repo={repo} name={viewing} onClose={() => view(undefined)} />
  ) : null;
}
