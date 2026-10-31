import { describe, expect, test } from "bun:test";
import { readOnlyCommand } from "../src/domain/read-only-command.ts";

const DIRS = ["/folder", "/repo/.metator/runs/r"];
const ro = (command: string) => readOnlyCommand(command, DIRS);

describe("readOnlyCommand", () => {
  test("searches and listings inside the working directories only read", () => {
    expect(ro('grep -rn "offers" backend/src --include=*.ts')).toBe(true);
    expect(ro('grep -rn "/api/offers" frontend/packages')).toBe(true);
    expect(ro("rg -n -e findAll -e list backend/src/module/offers")).toBe(true);
    expect(ro("find backend/src -name '*.controller.ts' | head -20")).toBe(true);
    expect(ro("ls -la /folder/backend")).toBe(true);
    expect(ro("cat /repo/.metator/runs/r/findings/merged.json | wc -l")).toBe(true);
    expect(ro("grep -rln offers . | sort | uniq")).toBe(true);
  });

  test("chains of readers, cd inside the directories, and output thrown away or joined still only read", () => {
    expect(
      ro(
        'cd /folder 2>/dev/null; find src/module/users -maxdepth 1 -type f 2>/dev/null; grep -rn "offer-reminder" src | head -20; grep -n findAll src/x.ts',
      ),
    ).toBe(true);
    expect(ro("grep -rn offers src 2>&1 | head -5 && ls src || ls")).toBe(true);
    expect(ro('ls node_modules/.bin 2>&1 | grep -E "^(jest|tsc)$"; ls node_modules | wc -l')).toBe(true);
    expect(ro("ls src;")).toBe(true);
    expect(ro("cd /elsewhere && ls")).toBe(false);
    expect(ro("grep -rn offers src 2>/tmp/err.txt")).toBe(false);
    expect(ro("grep -rn offers src >> out.txt")).toBe(false);
    expect(ro("ls & rm -rf src")).toBe(false);
    expect(ro(";")).toBe(false);
  });

  test("names set up front stand for their words, which are checked like any other", () => {
    expect(
      ro(
        "R=.metator/runs/r; grep -o '\"base[^,]*' $R/state.json $R/*.json | head; cat $R/task.md | head -40",
      ),
    ).toBe(true);
    expect(ro("D=/folder && ls $D/src; echo ---; ls $D")).toBe(true);
    expect(ro("D=/etc; cat $D/passwd")).toBe(false);
    expect(ro("R=x; rm -rf $R")).toBe(false);
    expect(ro("R=$(rm -rf src); ls")).toBe(false);
    expect(ro("R=x; cat $OTHER")).toBe(false);
  });

  test("sed that only prints a range of lines reads; any other sed does not", () => {
    expect(ro("sed -n 1,200p src/a.ts | grep -n Expose")).toBe(true);
    expect(ro("sed -n '10,$p' src/a.ts")).toBe(true);
    expect(ro("sed -i 's/a/b/' src/a.ts")).toBe(false);
    expect(ro("sed -i 1p src/a.ts")).toBe(false);
    expect(ro("sed -n '1w out.txt' src/a.ts")).toBe(false);
    expect(ro("sed -n 1,5p /etc/passwd")).toBe(false);
    expect(ro("sed 's/a/b/' src/a.ts")).toBe(false);
  });

  test("metator queries only read; commands that write or move a run do not", () => {
    expect(
      [
        "metator symbols find OfferListItemDto",
        "metator graph dependents src/a.ts --transitive",
        "metator rules show MT-TS-001",
        "metator run status",
        "metator review diff --base main src/a.ts",
        "metator plan lint .metator/runs/r/plan.json",
        "bun run metator graph deps src/a.ts",
        "metator api diff @acme/money",
        "npx metator help",
      ].map(ro),
    ).toEqual([true, true, true, true, true, true, true, true, true]);
    expect(
      [
        "metator run advance pass",
        "metator cards build",
        "metator index build",
        "metator review plan --out x.json",
        "metator graph diff --out x.json",
        "metator docs links --fix",
      ].map(ro),
    ).toEqual([false, false, false, false, false, false]);
  });

  test("metator help and a command's --help only print", () => {
    expect([ro("metator help"), ro("metator run answer --help"), ro("metator findings -h")]).toEqual([
      true,
      true,
      true,
    ]);
    expect(ro("metator run advance pass")).toBe(false);
    expect(ro("metator run advance --help --reason x")).toBe(false);
    expect(ro("metator --help; metator run advance pass")).toBe(false);
  });

  test("options that write or run, redirections, chains and substitutions do not", () => {
    expect(ro("find . -name '*.ts' -delete")).toBe(false);
    expect(ro("find . -exec rm {} ;")).toBe(false);
    expect(ro("rg --pre ./run.sh offers")).toBe(false);
    expect(ro("sort -o out.txt list.txt")).toBe(false);
    expect(ro("grep -rn offers . > out.txt")).toBe(false);
    expect(ro("grep offers a.ts && rm a.ts")).toBe(false);
    expect(ro("grep offers a.ts; rm a.ts")).toBe(false);
    expect(ro("cat $(which node)")).toBe(false);
    expect(ro("cat `which node`")).toBe(false);
    expect(ro("cat $HOME/.ssh/config")).toBe(false);
    expect(ro("grep a b.ts\nrm b.ts")).toBe(false);
  });

  test("programs that are not readers, and paths outside the working directories, do not", () => {
    expect(ro("node -e 'require(\"fs\")'")).toBe(false);
    expect(ro("git log")).toBe(false);
    expect(ro("cat /etc/passwd")).toBe(false);
    expect(ro("grep -r token ../other")).toBe(false);
    expect(ro("ls ~")).toBe(false);
    expect(ro("ls /folder-other")).toBe(false);
    expect(ro("")).toBe(false);
  });
});
