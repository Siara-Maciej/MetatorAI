---
kind: Lesson
schemaVersion: 1
id: a-sockets-input-waits-for-its-open-to-finish
title: A socket's input waits for its open to finish
createdAt: 2026-11-10T14:50:41.443Z
tags:
  - daemon
  - race
---
# A socket's input waits for its open to finish

When a WebSocket handler sets state in an async open (a pane found after an await), the message handler must await that open before acting: a client sends its first input on onopen, and a message that arrives before the state is set is dropped silently. Keep a ready promise on the socket's data and await it in message.

Evidence: [[cite: packages/cli/src/serve/server.ts:778 | "if (d.ready) await d.ready;"]]
