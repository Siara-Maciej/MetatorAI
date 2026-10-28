/**
 * A folder of repositories end to end (G2): three real repositories in one folder, each with its
 * own MetatorAI. In the folder, `repos` and `ui` cover all of them and every other command points
 * to the repository to run it in; inside a repository everything works as before.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { inTerminal, KEY } from "./helpers/terminal.ts";

let folder: string;
const WORKFLOW = "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: approval\n    hitl: true\n";

async function gitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) =>
    Bun.spawnSync(
      ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: dir,
      },
    );
  git("init", "-q", "-b", "main");
  await Bun.write(join(dir, ".gitignore"), ".metator/\n");
  await Bun.write(join(dir, ".github/metator/workflows/demo.yml"), WORKFLOW);
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "metator-folder-e2e-"));
  for (const name of ["shop", "billing", "services/mailer"]) await gitRepo(join(folder, name));
  await mkdir(join(folder, "notes"));
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("a folder of repositories (real CLI)", () => {
  test("repos list finds them; repos init writes metator.repos.yml once", async () => {
    const list = await metator(["repos", "list"], folder);
    const repos = (list.json.data as { file: null; repos: { name: string; path: string; setUp: boolean }[] })
      .repos;
    expect(repos.map((r) => [r.name, r.path])).toEqual([
      ["billing", "billing"],
      ["mailer", "services/mailer"],
      ["shop", "shop"],
    ]);
    const init = await metator(["repos", "init"], folder);
    expect((init.json.data as { written: string }).written).toBe(join(folder, "metator.repos.yml"));
    expect(await Bun.file(join(folder, "metator.repos.yml")).text()).toContain("kind: RepoSet");
    const again = await metator(["repos", "init"], folder);
    expect([again.code, (again.json.error as { message: string }).message]).toEqual([
      64,
      "metator.repos.yml already exists",
    ]);
    const fromFile = await metator(["repos", "list"], join(folder, "notes"));
    expect((fromFile.json.data as { file: string }).file).toBe(join(folder, "metator.repos.yml"));
  }, 60_000);

  test("in the folder a one-repository command says where to run it; inside a repository it runs", async () => {
    const here = await metator(["run", "init", "--workflow", "demo", "--task", "Add discount"], folder);
    const e = here.json.error as { message: string; hint: string };
    expect(here.code).toBe(64);
    expect(e.message).toBe(`\`metator run init\` works on one repository, and ${folder} is a folder of 3`);
    expect(e.hint).toContain("billing, mailer, shop");
    expect(e.hint).toContain("-C <repository>");
    const inside = await metator(
      ["run", "init", "--workflow", "demo", "--task", "Add discount"],
      join(folder, "shop"),
    );
    expect(inside.code).toBe(0);
    const withC = await metator(
      ["-C", join(folder, "billing"), "run", "init", "--workflow", "demo", "--task", "Fix VAT"],
      folder,
    );
    expect(withC.code).toBe(0);
    const status = await metator(["repos", "status"], folder);
    const rows = (status.json.data as { repos: { name: string; runs: number }[] }).repos;
    expect(rows.map((r) => [r.name, r.runs])).toEqual([
      ["billing", 1],
      ["mailer", 0],
      ["shop", 1],
    ]);
    const notFolder = await metator(["repos", "list"], join(folder, "shop"));
    expect((notFolder.json.error as { message: string }).message).toBe(
      "this is a repository, not a folder of repositories",
    );
  }, 60_000);

  test("metator ui in the folder: pick a repository, see its sessions, come back, quit", async () => {
    const r = await inTerminal(
      ["ui"],
      folder,
      [
        { waitFor: "3 repositories", keys: KEY.down + KEY.down + KEY.enter }, // billing · mailer · shop
        { waitFor: "demo-add-discount", keys: KEY.up + KEY.enter }, // Quit the repository's sessions
        { waitFor: "3 repositories", keys: KEY.up + KEY.enter }, // Quit
      ],
      60_000,
    );
    expect(r.code).toBe(0);
  }, 90_000);
});
