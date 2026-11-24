# Authoring guidance

## Contents
- Sources
- The description
- The body
- Disclosure
- Pruning
- Evaluation

## Sources
Anthropic's documentation comes first: the Agent Skills best practices (platform.claude.com, agents-and-tools/agent-skills/best-practices), the overview, and Claude Code's skills page (code.claude.com/docs/en/skills). The techniques below that are not from it come from a study of mattpocock/skills. The checkable part of all this is the canon's MT-SKILL rules (`metator rules show MT-SKILL-001` and on); this page is the rest.

## The description
- It is injected into the system prompt and is the only text an agent sees before choosing the skill: it says what the skill does and when to use it, in the third person.
- Put the key use case first, in the words a request would use; front-load the leading word.
- One trigger per distinct case: synonyms that rename one case are one case written twice.
- The anti-trigger names the nearest wrong case and the sibling to use instead (`…; use skill mt-create-from-pattern`).
- Claude Code truncates a long description in its listing; the spec caps it at 1024 characters, and the lint enforces that.

## The body
- **Concise.** The model is already capable: write only what changes its behavior compared with what it would do anyway. A sentence that changes nothing is a no-op; delete the whole sentence.
- **Instructions first.** After compaction Claude Code keeps only the start of an invoked skill, so Steps come right after a short When.
- **Completion criteria.** A step that can end too early ends on `Done when …`, checkable and exhaustive ("every public function in scope has its rows", not "make a list"). A gate stops the next step: "no red command, no hypothesis".
- **Facts and decisions.** Facts are the agent's to find with commands; decisions are the person's, asked with a recommended option.
- **Feedback loops.** For work whose quality matters: run the check, fix, run it again (a lint, a test seen red then green, `patterns scan`).
- **Degrees of freedom.** Exact commands where an operation is fragile; a heuristic where several approaches are valid.
- **One term per concept**, the same spelling throughout (this repository writes American English).
- **The positive target.** Say what to do ("fix the test, keep the code") rather than only what not to do. A hard guardrail that cannot be phrased positively is paired with its positive target.
- **Name failure modes** the model falls into, once, where they happen ("reading code to build a theory before the command exists is the failure this skill prevents").
- **A why for a rule** whose reason is not obvious, in one clause.
- **Examples** are concrete: a finding and a non-finding side by side, a correctly cited answer.
- **No dates** and nothing that will go stale; no option lists where one default with an escape hatch does.

## Disclosure
- Inline what every branch of the steps needs; move behind a pointer what only some branches reach.
- References stay one level deep: the skill names them; they name no other supporting file.
- A reference over 100 lines opens with `## Contents`.
- A script earns its place when it does work the agent would otherwise do by hand and handles its own errors. A script that only forwards to one command is a pointer: name the command instead.
- Paths use forward slashes.

## Pruning
- Each meaning in one place. A step that needs another skill names it ("use skill mt-find-patterns first"); it does not repeat that skill's steps.
- What a command, a schema or `--help` already says stays there: the skill points at it (`metator plan schema`), so it cannot go stale.
- Keep what the agent cannot find by looking: the unwritten convention, the reason for a choice, the trap no file confesses.

## Evaluation
- Write three scenarios before the body; run them without the skill to see the gap.
- After writing, run them with the skill on each host the repository targets, and watch how the agent moves through the skill: what it skips, what it reads too often, what it never reaches.
- A scenario that still fails is fixed in the description's trigger before more body text is added.
