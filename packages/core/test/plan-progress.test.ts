import { expect, test } from "bun:test";
import { hostNamed, runAgent } from "../src/application/agent-run.ts";
import type { AgentEvent } from "../src/domain/drive.ts";
import {
  type ApprovablePlan,
  approvePlan,
  asDraft,
  requireApproved,
  settled,
} from "../src/domain/plan-progress.ts";
import type { AgentHost } from "../src/ports/index.ts";

const APPROVAL = { by: "ann", at: "2026-01-01T00:00:00.000Z", digest: "d1" };
const plan = (over: Partial<ApprovablePlan> = {}): ApprovablePlan => ({ id: "p1", status: "draft", ...over });

test("approving needs a clean lint; a stale approval is the one error approving again fixes", () => {
  const approved = approvePlan(
    plan(),
    [{ severity: "warning" }],
    APPROVAL,
    "lint lists them",
  )._unsafeUnwrap();
  expect(approved).toEqual({ id: "p1", status: "approved", approval: APPROVAL });
  const stale = [{ severity: "error", code: "stale-approval" }];
  expect(approvePlan(plan({ status: "approved" }), stale, APPROVAL, "h").isOk()).toBe(true);
  const refused = approvePlan(plan(), [...stale, { severity: "error" }], APPROVAL, "lint lists them");
  const error = refused._unsafeUnwrapErr();
  expect([error.code, error.message, error.hint, error.details]).toEqual([
    "CHECK_FAILED",
    "p1: 1 lint error(s); fix them before approving",
    "lint lists them",
    { problems: [{ severity: "error" }] },
  ]);
});

test("a plan that runs or is done cannot be approved again", () => {
  for (const status of ["running", "done"] as const)
    expect(approvePlan(plan({ status }), [], APPROVAL, "h")._unsafeUnwrapErr().message).toBe(
      `p1 is ${status}; it cannot be approved again`,
    );
});

test("only a plan whose approval covers it as it is now may run", () => {
  const hint = "A person approves it.";
  const draft = requireApproved(plan({ approval: APPROVAL }), "d1", "moves", hint)._unsafeUnwrapErr();
  expect([draft.message, draft.hint]).toEqual(["p1 is not approved", hint]);
  expect(requireApproved(plan({ status: "approved" }), "d1", "moves", hint).isErr()).toBe(true);
  const changed = requireApproved(plan({ status: "approved", approval: APPROVAL }), "d2", "moves", hint);
  expect([changed._unsafeUnwrapErr().message, changed._unsafeUnwrapErr().hint]).toEqual([
    "the moves of p1 changed after ann approved them",
    "Approve the plan again.",
  ]);
  const ok = plan({ status: "running", approval: APPROVAL });
  expect(requireApproved(ok, "d1", "steps", hint)._unsafeUnwrap()).toBe(ok as never);
});

test("what an agent wrote is a draft: its approval is dropped; a draft stays the same object", () => {
  const draft = plan();
  expect(asDraft(draft)).toBe(draft);
  expect(asDraft(plan({ status: "approved", approval: APPROVAL }))).toEqual({ id: "p1", status: "draft" });
  expect(asDraft(plan({ status: "approved" }))).toEqual({ id: "p1", status: "draft" });
  expect(asDraft(plan({ approval: APPROVAL }))).toEqual({ id: "p1", status: "draft" });
});

test("a plan is settled when it has items and all are done", () => {
  expect([
    settled([]),
    settled([{ status: "done" }]),
    settled([{ status: "done" }, { status: "running" }]),
  ]).toEqual([false, true, false]);
});

test("a host is found by its id; an unknown id lists the hosts", () => {
  const hosts = new Map([
    ["claude", 1],
    ["copilot", 2],
  ]);
  expect(hostNamed(hosts, "copilot")._unsafeUnwrap()).toBe(2);
  const unknown = hostNamed(hosts, "nope")._unsafeUnwrapErr();
  expect([unknown.code, unknown.message, unknown.hint]).toEqual([
    "USAGE",
    "unknown host nope",
    "Hosts: claude, copilot.",
  ]);
});

test("an agent runs until it stops: events are passed on, a failed result is COMMAND_FAILED with the hint", async () => {
  const host = (events: AgentEvent[]): AgentHost =>
    ({
      async *run() {
        yield* events;
      },
    }) as unknown as AgentHost;
  const task = { agent: "mt-x", prompt: "p", cwd: "/r", projectRoot: "/r", runDir: "/r/d" };
  const deny = { choices: ["Deny"] };
  const seen: AgentEvent[] = [];
  const fine = await runAgent({
    host: host([{ type: "result", ok: true, text: "done" } as AgentEvent]),
    hostName: "claude",
    task,
    deny,
    hint: "again",
    onEvent: (e) => seen.push(e),
  });
  expect([fine.isOk(), seen.length]).toEqual([true, 1]);
  const failed = await runAgent({
    host: host([{ type: "result", ok: false, text: "" } as AgentEvent]),
    hostName: "claude",
    task,
    deny,
    hint: "again",
  });
  expect([
    failed._unsafeUnwrapErr().code,
    failed._unsafeUnwrapErr().message,
    failed._unsafeUnwrapErr().hint,
  ]).toEqual(["COMMAND_FAILED", "claude: mt-x stopped without a result", "again"]);
});
