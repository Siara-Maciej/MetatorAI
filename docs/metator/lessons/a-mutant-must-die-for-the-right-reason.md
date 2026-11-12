---
kind: Lesson
schemaVersion: 1
id: a-mutant-must-die-for-the-right-reason
title: A mutant must die for the right reason
createdAt: 2026-11-10T14:50:42.737Z
tags:
  - tests
  - mutation
---
# A mutant must die for the right reason

A test that expects an error proves nothing when the code can fail for another reason too: the proposal-cannot-start test also failed for a missing worktree, so the mutant that removed the check survived. Make the asserted failure the only one possible (here worktree: false) and check the message.

Evidence: [[cite: packages/core/test/issues.test.ts:173 | "const refusedStart = await w.issues.start(\"i001\", { workflow: \"demo\", worktree: false });"]]
