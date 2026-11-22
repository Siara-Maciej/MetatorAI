import { describe, expect, test } from "bun:test";
import { FakeAgentHost, FixedClock, InMemoryFileSystem, InstantTimer } from "@metator/testing";
import { DriveRun } from "../src/application/drive.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { CloseRun } from "../src/application/run-close.ts";
import { RunJournal } from "../src/application/run-journal.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { AdvanceRun, ApproveRun, InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import type { ProcessResult, ProcessRunner, ResolvedCommand } from "../src/ports/index.ts";

/** A system run's two stages: start what can start, then a gate that waits on the children. */
const WAITS = `kind: Workflow
schemaVersion: 2
id: waits
stages:
  - id: children
    owner: "script:metator system plan run --run {runDir}"
  - id: status
    gate: { script: "metator system plan status --run {runDir} --check --gate" }
    onFail: { goto: children, loop: waves }
loops: { waves: 3 }
`;
const PLAIN = `kind: Workflow
schemaVersion: 2
id: plain
stages:
  - id: status
    gate: { script: "./check.sh" }
    onFail: { goto: status, loop: tries }
loops: { tries: 2 }
`;

const envelope = (code: string, message: string, hint?: string) =>
  `${JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } })}\n`;

/** Answers each call of the gate script with the next of `gates`; every other command passes. */
class Gates implements ProcessRunner {
  readonly calls: ResolvedCommand[] = [];
  constructor(private readonly gates: Partial<ProcessResult>[]) {}
  async run(command: ResolvedCommand): Promise<ProcessResult> {
    this.calls.push(command);
    const gate = command.argv.includes("status") || command.argv[0] === "./check.sh";
    const next = gate ? (this.gates.shift() ?? { exitCode: 0 }) : { exitCode: 0 };
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, ...next };
  }
}

async function world(
  gates: Partial<ProcessResult>[],
  workflow = "waits",
  onSleep: () => Promise<void> = async () => {},
) {
  const fs = new InMemoryFileSystem({
    ".github/metator/workflows/waits.yml": WAITS,
    ".github/metator/workflows/plain.yml": PLAIN,
  });
  const clock = new FixedClock(new Date("2026-11-15T10:00:00.000Z"));
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const journal = new RunJournal(fs, repo, clock);
  const advance = new AdvanceRun(catalog, repo, clock);
  const process = new Gates(gates);
  let sleeps = 0;
  const drive = new DriveRun({
    catalog,
    repo,
    journal,
    advance,
    approve: new ApproveRun(advance, repo, clock, catalog),
    close: new CloseRun(advance, repo, fs, clock),
    hosts: new Map([["fake", new FakeAgentHost({})]]),
    process,
    fs,
    timer: new InstantTimer(async () => {
      sleeps++;
      await onSleep();
    }),
    root: "/repo",
    metatorCommand: "bun run metator",
  });
  const runId = (
    await new InitRun(catalog, repo, clock).execute({ workflow, task: "Add currency to prices" })
  )._unsafeUnwrap().runId;
  return { drive, runId, repo, journal, process, advance, sleeps: () => sleeps };
}

describe("a gate that waits on other work (W13: a system run's children)", () => {
  test("WAITING (exit 4) is no failure: the drive looks again, says what it waits on once per change, spends no loop", async () => {
    const w = await world([
      {
        exitCode: 4,
        stdout: envelope("WAITING", "waiting on children: shop-api working, shop-web not started"),
      },
      {
        exitCode: 4,
        stdout: envelope("WAITING", "waiting on children: shop-api working, shop-web not started"),
      },
      { exitCode: 4, stdout: envelope("WAITING", "waiting on children: shop-api done, shop-web working") },
      { exitCode: 0 },
    ]);
    const r = (await w.drive.execute({ runId: w.runId, host: "fake" }))._unsafeUnwrap();
    expect([r.status, r.stage]).toEqual(["done", "done"]);
    const record = (await w.repo.load(w.runId))._unsafeUnwrap();
    expect(record.state.context.loops).toEqual({});
    expect(w.sleeps()).toBe(3);
    const activity = (await w.journal.activity(w.runId))._unsafeUnwrap();
    expect(activity.filter((a) => a.type === "gate").map((a) => a.text)).toEqual([
      "waiting on children: shop-api working, shop-web not started",
      "waiting on children: shop-api done, shop-web working",
      `metator system plan status --run .metator/runs/${w.runId} --check --gate: pass`,
    ]);
    // The command is said once, not once per look.
    expect(activity.filter((a) => a.type === "tool" && a.text.includes("plan status")).length).toBe(1);
  });

  test("BLOCKED (exit 3) escalates at once, loops left; the reason is the error's message and hint, not its JSON", async () => {
    const w = await world([
      {
        exitCode: 3,
        stdout: envelope(
          "BLOCKED",
          "step shop-web-show is blocked: its run escalated",
          "Resolve it in shop-web, then resume this run.",
        ),
      },
    ]);
    const r = (await w.drive.execute({ runId: w.runId, host: "fake" }))._unsafeUnwrap();
    expect(r.status).toBe("escalated");
    const record = (await w.repo.load(w.runId))._unsafeUnwrap();
    expect(record.state.context.loops).toEqual({});
    expect(record.state.context.history.at(-1)).toEqual({
      stage: "status",
      event: "FAIL",
      // The command as it ran: no placeholder left in what a person reads.
      detail: `gate \`metator system plan status --run .metator/runs/${w.runId} --check --gate\`: step shop-web-show is blocked: its run escalated (Resolve it in shop-web, then resume this run.)`,
    });
  });

  test("a plain failure (exit 1) goes back as before, with the message read from the envelope", async () => {
    const w = await world([
      { exitCode: 1, stdout: envelope("CHECK_FAILED", "a step can start: shop-web-show") },
      { exitCode: 0 },
    ]);
    const r = (await w.drive.execute({ runId: w.runId, host: "fake" }))._unsafeUnwrap();
    expect(r.status).toBe("done");
    const record = (await w.repo.load(w.runId))._unsafeUnwrap();
    expect(record.state.context.loops).toEqual({ waves: 1 });
    expect(record.state.context.history.find((h) => h.event === "FAIL")?.detail).toBe(
      `gate \`metator system plan status --run .metator/runs/${w.runId} --check --gate\`: a step can start: shop-web-show`,
    );
  });

  test("exit 4 and 3 mean nothing special from a script that is not metator's own", async () => {
    const w = await world(
      [{ exitCode: 3, stderr: "flaky" }, { exitCode: 4, stderr: "still" }, { exitCode: 0 }],
      "plain",
    );
    const r = (await w.drive.execute({ runId: w.runId, host: "fake" }))._unsafeUnwrap();
    expect(r.status).toBe("done");
    expect(w.sleeps()).toBe(0);
    expect((await w.repo.load(w.runId))._unsafeUnwrap().state.context.loops).toEqual({ tries: 2 });
  });

  test("a run moved while the gate waits (aborted from another terminal): the drive stops waiting", async () => {
    let w: Awaited<ReturnType<typeof world>> | undefined;
    w = await world(
      Array.from({ length: 50 }, () => ({
        exitCode: 4,
        stdout: envelope("WAITING", "waiting on children: a working"),
      })),
      "waits",
      async () => {
        if (!w) return;
        const record = (await w.repo.load(w.runId))._unsafeUnwrap();
        if (record.state.status === "active")
          await w.advance.execute({ runId: w.runId, event: { type: "ABORT", reason: "not needed" } });
      },
    );
    const r = (await w.drive.execute({ runId: w.runId, host: "fake" }))._unsafeUnwrap();
    expect(r.status).toBe("aborted");
    expect(w.sleeps()).toBe(1);
  });
});
