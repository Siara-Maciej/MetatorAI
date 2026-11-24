/**
 * The decision card (screen 1, spec §6.3): everything a person needs to answer without opening
 * the session, composed by the daemon; the app only draws it and sends the answer back.
 */
import { useEffect, useRef, useState } from "react";
import type { InboxItem } from "../api.ts";
import { useDaemon, usePolled } from "../daemon.tsx";
import {
  answerCommand,
  duration,
  goalShown,
  groupStepText,
  hostPromptOf,
  humanPrompt,
  isFinished,
  isTerminalQuestion,
  needsReason,
  optionClosed,
  paneOfQuestion,
  questionKind,
  systemPlanOf,
} from "../model.ts";
import { isPublishGate, NOT_PUBLISHED } from "../reviews.ts";
import { askWhy, consentOf } from "../stage1.ts";
import { useAnswer } from "./answer.tsx";
import { ArtifactViewer } from "./artifact-viewer.tsx";
import { Chip } from "./chips.tsx";
import { CommandText, commandOf } from "./command-text.tsx";
import { Notice } from "./common.tsx";
import { FoldList } from "./fold-list.tsx";
import { AskForChanges, lintRequest, RunPlanFull, SystemPlanFull } from "./plan-approval-line.tsx";

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
    me,
    client,
    systemPlans,
    run: runOf,
    runs,
    planStepsOf,
    stepPlaceOf,
    panes,
  } = useDaemon("me", "client", "systemPlans", "run", "runs", "planStepsOf", "stepPlaceOf", "panes");
  const q = item.question;
  const [viewing, setViewing] = useState<string>();
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
  const a = useAnswer(q, item.repo, {
    initial: q.multiSelect || !first ? [] : [first],
    // From the card, without opening the session: the daemon notes the origin.
    origin: "inbox",
    onDone: onAnswered,
    ...(onRefused ? { onRefused } : {}),
  });
  const reasonField = useRef<HTMLInputElement>(null);
  // Enter sends the selected answer (the ⏎ on the button), unless a field or a button has the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || !a.ready) return;
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
      void a.send();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Reject or Other chosen: the cursor goes to the reason it asks for.
  const asksReason = a.reason;
  useEffect(() => {
    if (asksReason) reasonField.current?.focus();
  }, [asksReason]);
  // The options on the card's face: on a plan's approval only Approve, sent by the button itself.
  const faceOptions = q.options.filter((o) => !askedInWords(o.label));
  const onlyApprove = planGate && faceOptions.every((o) => o.label === "Approve");
  // One set of controls everywhere a decision is shown (Home's): the options are the choice and
  // one button sends it; Reject and Other ask for their reason inline. On a plan's approval the
  // two actions (Approve, Ask for changes) stand above the plan, so they are seen first.
  const actions = publish ? (
    <div className="actions" data-testid="publish-yes-no">
      <button
        type="button"
        className="primary"
        disabled={a.busy || closed.has("Approve")}
        title={closed.get("Approve")}
        onClick={() => void a.send(["Approve"])}
      >
        Yes
      </button>
      <button type="button" disabled={a.busy} onClick={() => void a.send(["Reject"], NOT_PUBLISHED)}>
        No
      </button>
    </div>
  ) : (
    <>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!a.ready}
          title={a.reason && !a.ready ? "write the reason first" : undefined}
          onClick={() => void a.send()}
        >
          {a.choices.length > 0 ? a.choices.join(", ") : "Choose"} ⏎
        </button>
      </div>
      {planGate ? (
        <AskForChanges
          blocked={closed.get("Approve")}
          lintText={lintRequest(lintOfPlan?.problems ?? [])}
          busy={a.busy}
          onSend={(words) => void a.send(["Reject"], words)}
        />
      ) : null}
    </>
  );
  return (
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
              <button
                type="button"
                key={o.label}
                className="option"
                aria-pressed={a.choices.includes(o.label)}
                disabled={closed.has(o.label)}
                title={closed.get(o.label) ?? o.description}
                onClick={() => a.toggle(o.label)}
              >
                <span className="label">
                  <span>{o.label}</span>
                  {card?.recommended === o.label ? <span className="rec">RECOMMENDED</span> : null}
                </span>
                {closed.has(o.label) ? <span className="cons red">closed: the reason is below</span> : null}
              </button>
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
      {a.reason ? (
        <label className="reason">
          <span className="amber">
            {`Reason for ${a.choices.find((c) => needsReason([c])) ?? "this answer"} (required)`}
          </span>
          <input
            ref={reasonField}
            aria-label="reason (required)"
            placeholder="the run gets your words; say what must change"
            value={a.text}
            onChange={(e) => a.setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && a.ready) void a.send();
            }}
          />
        </label>
      ) : null}
      {planGate ? null : actions}
      <Notice text={a.error} onClose={a.clearError} />
      <details className="card-details" data-testid="card-details">
        <summary>Details</summary>
        <div className="ctx">
          <span className="mono">{q.id}</span>
          <span>{questionKind(q)}</span>
          <span>{item.stage}</span>
          {item.repo ? <span>{item.repo}</span> : null}
          <span className="mono">{q.runId}</span>
          {q.agent ? <span>{q.agent}</span> : null}
          {askPane ? <span className="mono">pane {askPane}</span> : null}
          {host ? <span className="mono">pane {host.pane}</span> : null}
        </div>
        <div className="chips">
          {card ? (
            <Chip tone={card.reversible ? "green" : "red"}>
              {card.reversible ? "reversible" : "not reversible"}
            </Chip>
          ) : null}
          {card?.blastRadius ? (
            <Chip tone="violet">
              touches {card.blastRadius.files} file{card.blastRadius.files === 1 ? "" : "s"}
              {card.blastRadius.areas.length > 0 ? ` · ${card.blastRadius.areas.join(", ")}` : ""}
            </Chip>
          ) : null}
          <Chip tone="amber">waiting {duration(item.waitedMs)}</Chip>
          {item.driving ? <Chip tone="amber">agent idle</Chip> : null}
          {card?.costOfDelay?.map((c) => (
            <Chip key={c}>{c}</Chip>
          ))}
          {card?.group ? <Chip tone="blue">{groupText(card.group)}</Chip> : null}
        </div>
        {card && goalShown(q.prompt, card.task) ? (
          <section>
            <h3>Goal</h3>
            <div>{card.task}</div>
          </section>
        ) : null}
        {card?.soFar?.length ? (
          <section>
            <h3>Since you left</h3>
            <FoldList lines={card.soFar} label="since you left" />
          </section>
        ) : null}
        {card && (card.done.length > 0 || card.artifacts.length > 0) ? (
          <section>
            <h3>Proposal and evidence</h3>
            {card.done.length > 0 ? <div className="muted">done: {card.done.join(" → ")}</div> : null}
            {card.artifacts.length > 0 ? (
              <div className="muted">
                see:{" "}
                {card.artifacts.map((name, i) => (
                  <span key={name}>
                    {i > 0 ? " · " : null}
                    <button
                      type="button"
                      className="ghost link mono"
                      onClick={() => setViewing(name)}
                      title={`read ${name}`}
                    >
                      {name}
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {card.evidence?.length ? <FoldList lines={card.evidence} keep={3} label="evidence" /> : null}
          </section>
        ) : null}
        <section>
          <h3>What each answer does</h3>
          <ul className="consequences" data-testid="consequences">
            {q.options.map((o) => (
              <li key={o.label}>
                <strong>{o.label}</strong>
                {o.description ? <span className="muted"> · {o.description}</span> : null}
                {card?.consequences?.[o.label] ? (
                  <span className="cons"> → {card.consequences[o.label]}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        {a.reason ? null : (
          <label className="reason">
            <span className="dim">Note (optional)</span>
            <input
              aria-label="note"
              placeholder="a note for the log"
              value={a.text}
              onChange={(e) => a.setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && a.ready) void a.send();
              }}
            />
          </label>
        )}
        <div className="actions">
          <button type="button" onClick={() => onOpenChanges(q.runId)}>
            Changes
          </button>
          <button type="button" onClick={() => onOpenSession(q.runId)}>
            Open run · o
          </button>
        </div>
        <div className="footer-cmd mono">writes: {answerCommand(q, a.choices, me, a.text)}</div>
      </details>
      {viewing ? (
        <ArtifactViewer
          runId={q.runId}
          repo={item.repo}
          name={viewing}
          onClose={() => setViewing(undefined)}
        />
      ) : null}
    </article>
  );
}
