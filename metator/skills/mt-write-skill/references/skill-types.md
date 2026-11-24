# Skill types

Every type keeps the five sections in order (When, Steps, Output, Checklist, Errors); what goes in them differs.

## Workflow
A process with an order that matters (mt-diagnose, mt-characterization-tests).
- Steps are phases, each a bold leading word: **Build the loop**, **Reproduce and minimise**.
- The step that is most often skipped carries a gate: "no X, no next step".
- Each phase that can end too early ends on `Done when …`.
- Output is the artifact a later stage reads (`diagnosis.md`), with what it must hold.

## Interview
Questions to a person until nothing is left assumed (mt-grill).
- First the facts the agent finds itself; only decisions go to the person.
- Questions go in rounds: the frontier is every decision whose prerequisites are settled.
- Each question is numbered, with its options and a recommendation first, worded so "yes" accepts it.
- Done when the frontier is empty; every answer is written down with who decided.

## Lookup
A question mapped to the command that measures it (mt-read-java, mt-find-patterns).
- A table: question, then command.
- What the command's answer means (certain or likely, an ambiguous name, an empty result).
- Output is facts with their evidence, and one example of a correctly cited answer.

## Decision rubric
A candidate judged by fixed criteria (mt-review-rubric).
- One step per criterion, in the order they eliminate candidates.
- A table of levels with when and why each level.
- A kept and a dropped example side by side, in a reference.

## Command form
How to phrase actions so they run without friction (mt-run-without-asking).
- A table: instead of, use. Each row a form observed in real runs.
- The rules that cover rows not in the table.
- Errors: what to do when a form is still refused.
