/**
 * Home's cards on stores of their own (ADR-0113): an answer is chosen, written and sent from its
 * store; an escalated run resumes or closes from its card's store; a pane's question types the
 * choice or the words. Typing the person's words draws the field (and the command it writes), not
 * the options; typing a note or a task draws only that field.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createStore, type StoreApi } from "zustand/vanilla";
import { Answer, type AnswerInit, type AnswerState } from "../src/features/inbox/answer-state.ts";
import { NoteField as AnswerNote, WritesCommand } from "../src/features/inbox/card-details.tsx";
import { OptionButton, ReasonField } from "../src/features/inbox/decision-card.tsx";
import { NoteField, ResumePlanLine } from "../src/features/inbox/escalated-card.tsx";
import { TaskField } from "../src/features/inbox/inbox-screen.tsx";
import { OtherWords } from "../src/features/inbox/pane-ask-card.tsx";
import {
  Escalated,
  type EscalatedState,
  Home,
  type HomeState,
  type PaneAskState,
  PaneAskStore,
} from "../src/features/inbox/state.ts";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import type { Store } from "../src/shared/daemon/daemon-store.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";
import { counted, drawRoot, fakeDaemon } from "./screen-kit.tsx";

const question = (over: Record<string, unknown> = {}) =>
  ({
    id: "q1",
    runId: "r1",
    prompt: "Approve the plan?",
    source: "gate",
    multiSelect: false,
    options: [{ label: "Approve" }, { label: "Reject" }, { label: "Other" }],
    ...over,
  }) as never;

const answerInit = (daemon: Store<Daemon>, over: Partial<AnswerInit> = {}): AnswerInit => ({
  daemon,
  question: question(),
  repo: "shop",
  initial: [],
  ...over,
});
const answer = (daemon: Store<Daemon>, over: Partial<AnswerInit> = {}): StoreApi<AnswerState> =>
  createStore<AnswerState>()(Answer.create(answerInit(daemon, over)));

describe("an answer's state", () => {
  test("one option at a time, several on a multi-select question", () => {
    const one = answer(fakeDaemon().daemon, { initial: ["Approve"] });
    one.getState().toggle("Reject");
    expect(one.getState().choices).toEqual(["Reject"]);
    const many = answer(fakeDaemon().daemon, { question: question({ multiSelect: true }) });
    many.getState().toggle("a");
    many.getState().toggle("b");
    many.getState().toggle("a");
    expect(many.getState().choices).toEqual(["b"]);
  });

  test("a Reject without its reason sends nothing; with it, the words go trimmed with the origin", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = answer(daemon, { initial: ["Reject"], origin: "inbox" });
    const onDone = mock((..._args: unknown[]) => {});
    await s.getState().send({ onDone });
    expect(calls.answer).toBeUndefined();
    s.getState().setText("  split the step ");
    await s.getState().send({ onDone });
    expect(calls.answer?.[0]).toEqual([
      {
        runId: "r1",
        question: "q1",
        choices: ["Reject"],
        by: "ana",
        text: "split the step",
        origin: "inbox",
      },
      "shop",
    ]);
    expect([onDone.mock.calls[0], s.getState().busy]).toEqual([[["Reject"]], false]);
  });

  test("a refused answer says why and tells the caller; a cancelled name sends nothing", async () => {
    const { daemon } = fakeDaemon({ answer: { ok: false, error: { message: "already answered" } } });
    const s = answer(daemon, { initial: ["Approve"] });
    const onRefused = mock((..._args: unknown[]) => {});
    await s.getState().send({ onDone: () => {}, onRefused });
    expect([s.getState().error, onRefused.mock.calls[0]]).toEqual(["already answered", ["already answered"]]);
    s.getState().clearError();
    const nobody = fakeDaemon({}, { who: async () => "" });
    const t = answer(nobody.daemon, { initial: ["Approve"] });
    await t.getState().send({ onDone: () => {} });
    expect([s.getState().error, nobody.calls.answer]).toEqual([undefined, undefined]);
  });
});

describe("an escalated run's card", () => {
  const run = { runId: "r9", repo: "shop", stage: "implement" } as never;
  const escalated = (daemon: Store<Daemon>): StoreApi<EscalatedState> =>
    createStore<EscalatedState>()(Escalated.create({ daemon, stage: "implement" }));

  test("Resume at the stage it stopped sends no stage; with nothing to drive it the card stays and says so", async () => {
    const { daemon, calls } = fakeDaemon({
      resume: { ok: true, data: { drive: { error: "no host", hint: "install one" } } },
    });
    const s = escalated(daemon);
    s.getState().setNote("mind the cache");
    const onDone = mock((..._args: unknown[]) => {});
    await s.getState().resume(run, onDone);
    expect(calls.resume?.[0]).toEqual(["r9", "ana", "shop", { note: "mind the cache" }]);
    expect([onDone.mock.calls.length, s.getState().notice?.text]).toEqual([
      0,
      "Run r9 is resumed, but no agent works on it: no host install one",
    ]);
    s.getState().setTo("plan");
    await s.getState().resume(run, onDone);
    expect(calls.resume?.[1]?.[3]).toEqual({ to: "plan", note: "mind the cache" });
  });

  test("Close needs a reason; with one the run is closed and the card goes", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = escalated(daemon);
    const onDone = mock((..._args: unknown[]) => {});
    s.getState().toggleClosing();
    await s.getState().close(run, onDone);
    expect([calls.abort, s.getState().closing]).toEqual([undefined, true]);
    s.getState().setReason(" obsolete ");
    await s.getState().close(run, onDone);
    expect([calls.abort?.[0], onDone.mock.calls.length]).toEqual([["r9", "obsolete", "shop"], 1]);
  });
});

describe("a pane's question", () => {
  const ask = { paneId: "p1", repo: "shop", question: { id: "q2" } } as never;
  const paneAsk = (daemon: Store<Daemon>): StoreApi<PaneAskState> =>
    createStore<PaneAskState>()(PaneAskStore.create({ daemon }));

  test("Other types the person's words; Attach answers and opens the pane", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = paneAsk(daemon);
    const onAnswered = mock((..._args: unknown[]) => {});
    const onOpenPane = mock((..._args: unknown[]) => {});
    await s.getState().send(ask, onAnswered, onOpenPane);
    expect(calls.answerPane).toBeUndefined();
    s.getState().choose("Other");
    s.getState().setWords(" use main ");
    await s.getState().send(ask, onAnswered, onOpenPane);
    expect(calls.answerPane?.[0]).toEqual([
      { paneId: "p1", question: "q2", choices: [], by: "ana", text: "use main" },
      "shop",
    ]);
    s.getState().choose("Attach and answer in the pane");
    await s.getState().send(ask, onAnswered, onOpenPane);
    expect([onAnswered.mock.calls, onOpenPane.mock.calls.length]).toEqual([
      [[["use main"]], [["Attach and answer in the pane"]]],
      1,
    ]);
  });
});

let answerApi: StoreApi<AnswerState> | undefined;
let escalatedApi: StoreApi<EscalatedState> | undefined;
let homeApi: StoreApi<HomeState> | undefined;
let paneApi: StoreApi<PaneAskState> | undefined;
function Grab() {
  answerApi = useScopedApi(Answer);
  return null;
}
function GrabEscalated() {
  escalatedApi = useScopedApi(Escalated);
  return null;
}
function GrabHome() {
  homeApi = useScopedApi(Home);
  return null;
}
function GrabPane() {
  paneApi = useScopedApi(PaneAskStore);
  return null;
}

describe("parts of Home's cards", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  const done = { onDone: () => {} };

  test("typing the reason draws the field and the command it writes, not the options", async () => {
    const { daemon } = fakeDaemon();
    const draws: Record<string, number> = {};
    const r = await drawRoot();
    r.draw(
      <ScopeProvider store={Answer} init={answerInit(daemon, { initial: ["Reject"] })}>
        <Grab />
        {counted(draws, "approve", <OptionButton label="Approve" closedWhy={undefined} recommended={true} />)}
        {counted(draws, "reject", <OptionButton label="Reject" closedWhy={undefined} recommended={false} />)}
        {counted(draws, "reason", <ReasonField done={done} />)}
        {counted(draws, "note", <AnswerNote done={done} />)}
        {counted(draws, "writes", <WritesCommand question={question()} />)}
      </ScopeProvider>,
    );
    expect(r.host.querySelector('[aria-label="reason (required)"]')).not.toBeNull();
    r.act(() => answerApi?.getState().setText("t"));
    r.act(() => answerApi?.getState().setText("to"));
    expect(draws).toEqual({ approve: 1, reject: 1, reason: 3, note: 1, writes: 3 });
    // Approve chosen: the reason goes, the note comes; the options that changed draw again.
    r.act(() => answerApi?.getState().toggle("Approve"));
    expect([draws.approve, draws.reject, r.host.querySelector('[aria-label="note"]') !== null]).toEqual([
      2,
      2,
      true,
    ]);
    r.done();
  });

  test("typing an escalated run's note, a task or a pane's words draws only that field", async () => {
    const { daemon } = fakeDaemon();
    const draws: Record<string, number> = {};
    const r = await drawRoot();
    r.draw(
      <>
        <ScopeProvider store={Escalated} init={{ daemon, stage: "implement" }}>
          <GrabEscalated />
          {counted(draws, "note", <NoteField />)}
          {counted(draws, "plan", <ResumePlanLine stage="implement" />)}
        </ScopeProvider>
        <ScopeProvider store={Home} init={{ daemon }}>
          <GrabHome />
          {counted(draws, "task", <TaskField onStart={() => {}} />)}
        </ScopeProvider>
        <ScopeProvider store={PaneAskStore} init={{ daemon }}>
          <GrabPane />
          {counted(draws, "words", <OtherWords />)}
        </ScopeProvider>
      </>,
    );
    r.act(() => escalatedApi?.getState().setNote("m"));
    r.act(() => homeApi?.getState().setTask("a"));
    r.act(() => paneApi?.getState().setWords("w"));
    expect(draws).toEqual({ note: 2, plan: 1, task: 2, words: 1 });
    r.act(() => paneApi?.getState().choose("Other"));
    r.act(() => paneApi?.getState().setWords("wo"));
    expect([
      draws.words,
      (r.host.querySelector('[aria-label="your words"]') as HTMLTextAreaElement).value,
    ]).toEqual([3, "wo"]);
    r.done();
  });
});
