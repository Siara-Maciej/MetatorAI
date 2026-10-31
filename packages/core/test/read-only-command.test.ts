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
