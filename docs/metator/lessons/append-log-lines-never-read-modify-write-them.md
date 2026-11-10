---
kind: Lesson
schemaVersion: 1
id: append-log-lines-never-read-modify-write-them
title: Append log lines, never read-modify-write them
createdAt: 2026-11-10T14:50:42.122Z
tags:
  - journal
  - race
---
# Append log lines, never read-modify-write them

A journal file that several processes write (hooks, the daemon, the CLI) must be appended in one step; reading the file and writing it back with one more line loses the other writer's line under load. The FileSystem port has append for this.

Evidence: [[cite: packages/core/src/application/drive.ts:156 | "return this.fs.append(this.activityFile(runId), line);"]]
