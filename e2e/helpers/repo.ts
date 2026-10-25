import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway git repository for e2e tests: real files, real git, nothing mocked. */
export class ScratchRepo {
  private constructor(readonly root: string) {}

  static async create(): Promise<ScratchRepo> {
    const repo = new ScratchRepo(await mkdtemp(join(tmpdir(), "metator-e2e-")));
    await repo.git("init", "-q", "-b", "main");
    return repo;
  }

  async write(path: string, content: string): Promise<void> {
    await Bun.write(join(this.root, path), content);
  }

  async read(path: string): Promise<string> {
    return Bun.file(join(this.root, path)).text();
  }

  async exists(path: string): Promise<boolean> {
    return Bun.file(join(this.root, path)).exists();
  }

  async commit(message: string): Promise<void> {
    await this.git("add", "-A");
    await this.git("commit", "-q", "-m", message);
  }

  async git(...args: string[]): Promise<string> {
    const proc = Bun.spawn(
      [
        "git",
        "-c",
        "user.email=e2e@example.com",
        "-c",
        "user.name=E2E",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: this.root, stdout: "pipe", stderr: "pipe" },
    );
    const [out, errText, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${errText}`);
    return out;
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  parent(): string {
    return dirname(this.root);
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
