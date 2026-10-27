# Skills

Skills are reusable procedures with optional scripts. A host loads a skill when its description matches the task, so every skill says when to use it **and when not to**.

| Skill | Use it when | Do not use it when |
|---|---|---|
| `mt-find-patterns` | a plan or an implementation creates a new file or symbol and needs the exemplar to follow | plain text search, review |
| `mt-create-from-pattern` | a step creates a file that follows a cataloged pattern | no pattern fits: that is a new abstraction with an ADR |
| `mt-characterization-tests` | a refactor must pin today's behavior with tests that pass on the old code | new features or bug fixes |
| `mt-review-rubric` | a lens decides whether something is a finding and how severe | finding problems in the first place |
| `mt-grill` | a task is ambiguous at intake | the plan is approved, or the code can answer the question |
| `mt-diagnose` | a test, a gate or a bug fails and the cause is not obvious | writing the fix |

## Anatomy of a skill

```text
metator/skills/mt-find-patterns/
├── SKILL.md            # versioned front matter (kind: Skill) + procedure, checklist, errors
└── scripts/similar.sh  # optional helper the host may run
```

```bash
metator meta skills-lint     # trigger and anti-trigger in the description, referenced files exist, size
metator meta skills-schema   # the JSON Schema of the front matter
metator generate             # .claude/skills/ and .github/skills/
```
