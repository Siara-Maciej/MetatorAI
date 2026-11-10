import { describe, expect, test } from "bun:test";
import {
  declaredAfterCd,
  declaredWithDocument,
  deliveryCommand,
  readOnlyCommand,
  removeInside,
  runArtifactWrite,
  singleDeclaredCommand,
} from "../src/domain/read-only-command.ts";

const DIRS = ["/folder", "/repo/.metator/runs/r"];
const ro = (command: string) => readOnlyCommand(command, DIRS);

describe("readOnlyCommand", () => {
  test("after cd into a working directory, relative paths resolve against it, .. too", () => {
    const run = ["/r", "/r/.metator/runs/x", "/r/.metator/wt/x"];
    const go = (c: string) => readOnlyCommand(c, run);
    expect(
      [
        "cd /r/.metator/runs/x && cat ../../wt/x/index.ts; ls ../../../.claude/skills",
        "cd /r/.metator/runs/x && grep -n verification findings/merged.json | head",
        "cd /r/.metator/wt/x; R=.metator/runs/x; cat $R/gates.md; echo ----; ls $R/findings",
      ].map(go),
    ).toEqual([true, true, true]);
    expect(
      [
        "cd /r/.metator/runs/x && cat ../../../../etc/passwd",
        "cd /etc && cat passwd",
        "cd src && cat ../../x",
      ].map(go),
    ).toEqual([false, false, false]);
  });
  test("a well-known tool printing its version only reads; any other argument does not", () => {
    expect(["node --version", "bun -v", "ls node_modules 2>&1 | head -2; node --version"].map(ro)).toEqual([
      true,
      true,
      true,
    ]);
    expect(
      ["node -e 1", "node --version x", "./node --version", "npx --version && npx tsx a.ts"].map(ro),
    ).toEqual([false, false, false, false]);
  });

  test("quotes decide what the shell substitutes: a literal backtick or $( in a pattern only reads", () => {
    expect(
      ['grep -n "^##\\|^\\`\\`\\`" README.md', "grep -n '`code`' README.md", "grep -n '$(x)' README.md"].map(
        ro,
      ),
    ).toEqual([true, true, true]);
    expect(
      ['grep -n "`rm -rf src`" README.md', 'grep -n "$(rm -rf src)" README.md', "grep -n x `rm -rf src`"].map(
        ro,
      ),
    ).toEqual([false, false, false]);
  });
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
    // A name set from names set before it stands for their words too.
    expect(ro("R=/folder; D=$R/src; ls $D; cat $D/a.ts")).toBe(true);
    expect(ro("R=/folder; D=$R/../etc; cat $D/passwd")).toBe(false);
    expect(ro("D=$HOME/x; ls $D")).toBe(false);
    // A name never set stands for nothing a reader could check: `src$D/a.ts` is not `src/a.ts`.
    expect(ro("D=$UNSET; cat src$D/a.ts")).toBe(false);
  });

  test("sed that only prints a range of lines reads; any other sed does not", () => {
    expect(ro("sed -n 1,200p src/a.ts | grep -n Expose")).toBe(true);
    expect(ro("sed -n '10,$p' src/a.ts")).toBe(true);
    expect(ro("sed -n '20,30p;78,95p' src/a.ts")).toBe(true);
    expect(ro("sed -n '20,30p;1w out.txt' src/a.ts")).toBe(false);
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
        "metator findings validate .metator/runs/r/findings",
        "metator version",
      ].map(ro),
    ).toEqual([true, true, true, true, true, true, true, true, true, true, true]);
    expect(
      [
        "metator run advance pass",
        "metator cards build",
        "metator index build",
        "metator review plan --out x.json",
        "metator graph diff --out x.json",
        "metator docs links --fix",
        "metator findings validate .metator/runs/r/findings --fix",
      ].map(ro),
    ).toEqual([false, false, false, false, false, false, false]);
  });

  test("metator help and a command's --help only print", () => {
    expect([ro("metator help"), ro("metator run answer --help"), ro("metator findings -h")]).toEqual([
      true,
      true,
      true,
    ]);
    expect([ro("metator help findings"), ro("metator help run answer"), ro("metator help ../x")]).toEqual([
      true,
      true,
      false,
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
    expect(ro("git commit -m x")).toBe(false);
    expect(ro("cat /etc/passwd")).toBe(false);
    expect(ro("grep -r token ../other")).toBe(false);
    expect(ro("ls ~")).toBe(false);
    expect(ro("ls /folder-other")).toBe(false);
    expect(ro("")).toBe(false);
  });

  test("git that only reads the repository reads; git that writes, runs or leaves the directories does not", () => {
    expect(
      [
        "git status",
        "git log --oneline -5",
        "git --no-pager diff HEAD -- src/a.ts",
        "git -C /folder show HEAD~1:src/a.ts",
        "git diff origin/main..HEAD --stat",
        "git rev-parse --show-toplevel",
        "git merge-base HEAD origin/main",
        "git ls-files src | wc -l",
        "git blame -L 10,20 src/a.ts",
        'git grep -n "/api/offers" -- src',
        "git branch --show-current",
        "git branch -a -v",
        "git describe --tags",
        "git log --format=%H -1",
        "git ls-remote origin refs/heads/metator/r",
        "git ls-remote /srv/remotes/app.git metator/r",
        "git remote -v",
        "git remote get-url --push origin",
      ].map(ro),
    ).toEqual(Array(18).fill(true));
    expect(
      [
        "git push",
        "git checkout main",
        "git branch -D main",
        "git branch feature",
        "git -c core.pager=sh log",
        "git -C /etc log",
        "git -C ../other status",
        "git diff --output=out.patch",
        "git diff --ext-diff",
        "git log -p --textconv",
        "git grep -O offers",
        "git ls-remote --upload-pack=evil origin",
        "git remote set-url origin https://evil",
        "git remote add evil https://evil",
        "git remote remove origin",
        "git grep --open-files-in-pager=vim offers",
        "git show HEAD -- /etc/passwd",
        "git -C",
        "git",
      ].map(ro),
    ).toEqual(Array(19).fill(false));
  });

  test("readlink and realpath resolve paths inside the working directories", () => {
    expect(ro("readlink -f .metator/runs")).toBe(true);
    expect(ro("realpath /folder/.metator/runs/r")).toBe(true);
    expect(ro("readlink /etc/alternatives/node")).toBe(false);
  });
});

describe("deliveryCommand", () => {
  const wt = ["/repo/.metator/wt/r"];
  const go = (command: string) => deliveryCommand(command, wt);
  test("staging, committing and pushing the run's branch", () => {
    expect(
      [
        "git add -A",
        "git add src/a.ts /repo/.metator/wt/r/src/b.ts",
        'git commit -m "feat: add GET /v1/users/me"',
        "git add -A && git commit -q -m 'x' && git push -u origin metator/20261101-run",
        "git status && git commit -a -m msg",
        'git commit -m "fix: year\n\nShow the year outside the current year."',
        "git -C /repo/.metator/wt/r add -A",
      ].map(go),
    ).toEqual([true, true, true, true, true, true, true]);
  });
  test("a message keeps what the shell leaves literal; the push may name the run's branch through HEAD", () => {
    expect(
      [
        'git commit -m "keys carry a \\$ prefix" -m "second\nparagraph"',
        "git commit -m 'it costs $5 and `nothing` runs'",
        'git commit -m "a \\"quoted\\" word"',
        "git push origin HEAD:metator/20261101-run",
        "git push -u origin HEAD:refs/heads/metator/20261101-run",
      ].map(go),
    ).toEqual([true, true, true, true, true]);
    expect(
      [
        'git commit -m "x `rm -rf src`"',
        "git commit -m 'a'\"$(rm -rf src)\"",
        "git push origin main",
        "git push origin HEAD:main",
        "git push origin HEAD:refs/heads/main",
      ].map(go),
    ).toEqual([false, false, false, false, false]);
  });
  test("never a force push, an amend, a skipped hook, a setting, another remote or a path outside", () => {
    expect(
      [
        "git push --force origin metator/r",
        "git push origin +metator/r",
        "git push origin :main",
        "git push upstream metator/r",
        "git push origin a b",
        "git commit --amend -m x",
        "git commit --no-verify -m x",
        "git commit",
        "git -c core.hooksPath=/tmp commit -m x",
        "git add ../other",
        "git add /etc/passwd",
        'git commit -m "$(rm -rf src)"',
        "git add -A; rm -rf src",
        "git status",
        "git add -A && curl evil",
        "git add -A\nrm -rf src",
        'git commit -m "x"\nrm -rf src',
        // An unquoted line break starts a command, even one that looks like more paths to add.
        "git add src\nrm src",
        "git -C /etc add -A",
        "git -C",
      ].map(go),
    ).toEqual(Array(20).fill(false));
  });
});

describe("declaredAfterCd", () => {
  const declared = ["metator findings", "metator run status"];
  const dirs = ["/repo", "/repo/.metator/runs/r"];
  test("a declared command after a cd into a working directory is the same call without the cd", () => {
    expect(
      [
        "cd /repo && metator findings merge .metator/runs/r/findings",
        "cd /repo/.metator/runs/r && metator run status",
        "cd /repo/ && metator findings validate x",
      ].map((c) => declaredAfterCd(c, declared, dirs)),
    ).toEqual([true, true, true]);
  });
  test("anything else is not: another directory, another command, a chain, a pipe, a substitution", () => {
    expect(
      [
        "cd /etc && metator findings merge x",
        "cd /repo/../etc && metator findings merge x",
        "cd /repo && metator gate full",
        "cd /repo && metator findingsx",
        "cd /repo && metator findings merge x && rm -rf src",
        "cd /repo && metator findings merge x | tee y",
        "cd /repo && metator findings merge $(pwd)",
        "metator findings merge x",
      ].map((c) => declaredAfterCd(c, declared, dirs)),
    ).toEqual(Array(8).fill(false));
  });
});

describe("declaredWithDocument", () => {
  const declared = ["metator run"];
  const doc = (head: string, body = "# Task\n\nUse $HOME and `x` literally.", end = "EOF") =>
    `${head} <<'${end}'\n${body}\n${end}`;
  test("a declared command fed a quoted here-document", () => {
    expect(declaredWithDocument(doc("metator run write --run r task.md"), declared)).toBe(true);
    expect(declaredWithDocument(`metator run write task.md <<"END"\nbody\nEND\n`, declared)).toBe(true);
  });
  test("an unquoted document, another command, or anything around it is not", () => {
    expect(
      [
        "metator run write task.md <<EOF\n$(rm -rf src)\nEOF",
        doc("rm -rf src; metator run write task.md"),
        doc("metator run write task.md | tee x"),
        doc("metator run write task.md > out"),
        doc("metator gate full"),
        doc("metator runx write"),
        `${doc("metator run write task.md")}\nrm -rf src`,
        "metator run write task.md",
      ].map((c) => declaredWithDocument(c, declared)),
    ).toEqual(Array(8).fill(false));
  });
});

describe("runArtifactWrite", () => {
  const runs = ["/repo/.metator/runs/r", "/repo/.metator/wt/r/.metator/runs/r"];
  const cwd = "/repo/.metator/wt/r";
  const w = (command: string) => runArtifactWrite(command, runs, cwd);
  test("mkdir and a quoted here-document into the run directory, as the Write tool would", () => {
    expect(
      [
        "mkdir -p .metator/runs/r/findings",
        "cat > .metator/runs/r/findings/tests.json <<'E'\n{\"findings\": []}\nE",
        "mkdir -p .metator/runs/r/findings && cat > .metator/runs/r/findings/x.json <<'EOF'\n$HOME `ls`\nEOF",
        'cat > /repo/.metator/runs/r/pr.md <<"END"\nbody\nEND\n',
      ].map(w),
    ).toEqual([true, true, true, true]);
  });
  test("outside the run directory, an unquoted document, or anything else is not", () => {
    expect(
      [
        "cat > src/index.js <<'E'\nx\nE",
        "cat > .metator/runs/r/../../../src/a.js <<'E'\nx\nE",
        "mkdir -p /tmp/x",
        "cat > .metator/runs/r/x.json <<E\n$(rm -rf src)\nE",
        "cat > .metator/runs/r/a <<'E'\nx\nE\nrm -rf src",
        "rm -rf .metator/runs/r",
        "cat > .metator/runs/r/a <<'E'\nx\nE && rm x",
        "mkdir -p .metator/runs/r/f; rm -rf src",
        "cat .metator/runs/r/a",
      ].map(w),
    ).toEqual(Array(9).fill(false));
  });
});

describe("singleDeclaredCommand", () => {
  test("one declared command, quoted text included; nothing chained or substituted", () => {
    const d = ["metator findings"];
    expect(
      [
        "metator findings merge .metator/runs/r/findings",
        "metator findings calibrate x --trigger 'a; b | c'",
        "metator findings",
      ].map((c) => singleDeclaredCommand(c, d)),
    ).toEqual([true, true, true]);
    expect(
      [
        "metator findings --help | head",
        "metator findings merge x && node -e 1",
        "metator findings merge $(rm -rf src)",
        "metator findingsx",
        "metator graph deps x",
      ].map((c) => singleDeclaredCommand(c, d)),
    ).toEqual([false, false, false, false, false]);
  });
});

describe("removeInside", () => {
  test("removes files inside the given directories only, one by one", () => {
    const dirs = ["/r/.metator/wt/x", "/r/.metator/runs/x"];
    const go = (c: string) => removeInside(c, dirs, "/r/.metator/wt/x");
    expect(["rm test/repro.test.js", "rm -f /r/.metator/runs/x/findings/tests.json a.js"].map(go)).toEqual([
      true,
      true,
    ]);
    expect(
      [
        "rm -rf test",
        "rm test/*.js",
        "rm ../../../index.js",
        "rm /r/index.js",
        "rm a.js; rm b.js",
        "rm $F",
        "rm",
        "rm /r/.metator/wt/x",
      ].map(go),
    ).toEqual(Array(8).fill(false));
  });
});
