/**
 * `metator ask` end to end (G3): the real CLI asks mt-guide through the scenario host (no model),
 * keeps the conversation, checks every cited file and continues the host's session on a
 * follow-up, in a repository and in a folder of repositories.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { inTerminal } from "./helpers/terminal.ts";

const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-guide:
    - - tool: { name: Read, summary: src/discount.ts }
      - say: "The discount is a flat 10% (src/discount.ts:1); orders apply it in src/order.ts:2."
    - - say: "There is no cap yet; one would go next to src/discount.ts:1. See also src/cap.ts:4."
`;

let repo: ScratchRepo;
let env: Record<string, string>;
const ask = (...args: string[]) => metator(["ask", ...args, "--host", "scenario"], repo.root, env);

interface Answer {
  conversation: string;
  host: string;
  turn: number;
  answer: string;
  citations: { path: string; line: number; exists: boolean }[];
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write("src/discount.ts", "export const discount = (total: number) => total * 0.9;\n");
  await repo.write(
    "src/order.ts",
    'import { discount } from "./discount.ts";\nexport const pay = (t: number) => discount(t);\n',
  );
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_USER: "maciej" };
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator ask (real CLI)", () => {
  test("a question is answered with citations that are checked; the conversation is kept", async () => {
    const r = await ask("How", "is", "the", "discount", "computed?");
    expect(r.code).toBe(0);
    const a = r.json.data as Answer;
    expect([a.host, a.turn, a.answer]).toEqual([
      "scenario",
      1,
      "The discount is a flat 10% (src/discount.ts:1); orders apply it in src/order.ts:2.",
    ]);
    expect(a.citations).toEqual([
      { path: "src/discount.ts", line: 1, exists: true },
      { path: "src/order.ts", line: 2, exists: true },
    ]);
    expect(a.conversation).toMatch(/^\d{8}-how-is-the-discount-computed$/);
    const saved = JSON.parse(await repo.read(`.metator/conversations/${a.conversation}.json`));
    expect([saved.kind, saved.hostSession, saved.turns[0].by]).toEqual([
      "Conversation",
      "scenario-mt-guide-1",
      "maciej",
    ]);
  }, 30_000);

  test("a follow-up continues the session; a cited file that does not exist is a warning", async () => {
    const r = await ask("Is there a cap?", "--continue");
    const a = r.json.data as Answer;
    expect([a.turn, a.answer]).toEqual([
      2,
      "There is no cap yet; one would go next to src/discount.ts:1. See also src/cap.ts:4.",
    ]);
    expect(r.json.warnings).toEqual([
      "the answer cites src/cap.ts:4, but there is no such file: check that claim",
    ]);
    const list = await metator(["ask", "list"], repo.root, env);
    const conversations = (list.json.data as { conversations: { title: string; turns: number }[] })
      .conversations;
    expect(conversations).toEqual([
      expect.objectContaining({ title: "How is the discount computed?", turns: 2 }),
    ]);
  }, 30_000);

  test("in a terminal the tools and the answer are shown as they arrive", async () => {
    const r = await inTerminal(
      ["ask", "Where", "is", "the", "discount?", "--host", "scenario"],
      repo.root,
      [{ waitFor: "Read src/discount.ts", keys: "" }],
      30_000,
      env,
    );
    expect(r.code).toBe(0);
    expect(r.screen).toContain("· Read src/discount.ts");
    expect(r.screen).toContain("The discount is a flat 10%");
  }, 60_000);

  test("errors: no question, an unknown conversation, nothing to continue elsewhere", async () => {
    expect((await ask()).json.error).toMatchObject({ code: "USAGE", message: "ask what?" });
    const none = await ask("x", "--conversation", "20261028-nope");
    expect((none.json.error as { code: string }).code).toBe("NOT_FOUND");
    const fresh = await ScratchRepo.create();
    await fresh.write("README.md", "# fresh\n");
    await fresh.commit("init");
    const r = await metator(["ask", "x", "--continue", "--host", "scenario"], fresh.root, env);
    expect((r.json.error as { message: string }).message).toBe("no conversation to continue");
    await fresh.dispose();
  }, 30_000);

  test("in a folder of repositories the question covers all of them; the conversation lives in the folder", async () => {
    const folder = await mkdtemp(join(tmpdir(), "metator-ask-folder-"));
    const shop = join(folder, "shop");
    Bun.spawnSync(["git", "init", "-q", shop]);
    const r = await metator(
      ["ask", "Which", "repositories", "are", "here?", "--host", "scenario"],
      folder,
      env,
    );
    expect(r.code).toBe(0);
    const id = (r.json.data as Answer).conversation;
    expect(await Bun.file(join(folder, ".metator/conversations", `${id}.json`)).exists()).toBe(true);
    await rm(folder, { recursive: true, force: true });
  }, 30_000);
});
