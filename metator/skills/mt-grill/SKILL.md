---
kind: Skill
schemaVersion: 1
name: mt-grill
description: Use when a task is ambiguous at intake (unclear scope, conflicting requirements, missing acceptance criteria) and the run must not guess. Do not use once the plan is approved or for questions the code can answer.
---
# When
The intake stage finds a requirement that allows two readings, or the task has no acceptance criteria.

# Steps
1. Answer what the code can answer yourself: `metator symbols find`, `metator graph`, module cards.
2. List the remaining ambiguities; for each give the readings you see and what each would change in the plan.
3. Ask them in one message, numbered, each with options (the first one your recommendation).
4. Record the answers in `task.md` under "Decisions", with who decided.

# Output
`task.md` with acceptance criteria and decisions; the run continues only after the answers.

# Checklist
- [ ] no question the repository could answer
- [ ] every question has options and a recommendation
- [ ] the answers are written down, not only remembered

# Errors
No answer in reasonable time: stop the run with `metator run advance abort --reason "waiting for decisions"`; never pick an option yourself.
