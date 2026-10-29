# Ask about the code

**What for:** not every question is a feature or a review. "How is the discount computed?", "Where do we retry failed payments?", "Why does the gateway talk to billing at all?" deserve a straight answer from the code, with the lines that prove it.

```bash
metator ask "How is the discount computed?"
```

```text
  · Read src/discount.ts
  · Bash metator graph dependents src/discount.ts
The discount is a flat 10% (src/discount.ts:1); orders apply it before tax in src/order.ts:12.
Nothing caps it today; a cap would sit next to src/discount.ts:1.
```

```json
{"ok":true,"data":{"conversation":"20261028-how-is-the-discount-computed","host":"claude","turn":1,
 "answer":"The discount is a flat 10% (src/discount.ts:1); …",
 "citations":[{"path":"src/discount.ts","line":1,"exists":true},{"path":"src/order.ts","line":12,"exists":true}]}}
```

**What happens:**
1. `mt-guide`, a read-only agent, answers through your AI host (Claude Code, GitHub Copilot or the scenario host). It finds the code with `metator symbols`, `similar` and `graph`, reads it, and cites every claim as `path:line`.
2. MetatorAI checks every cited file. A citation of a file that does not exist comes back as a warning: check that claim before you rely on it.
3. The conversation is kept in `.metator/conversations/<id>.json` (`Conversation`).

In a terminal the answer is shown as it arrives; without one you get the envelope above.

## Follow-ups

```bash
metator ask "Is there a cap?" --continue                       # the latest conversation
metator ask "And for B2B orders?" --conversation 20261028-how-is-the-discount-computed
metator ask list                                               # every conversation, newest first
```

A follow-up continues the host's own session, so the guide remembers what it read. Switch hosts with `--host copilot`: the new host gets the earlier questions and answers instead.

## In a folder of repositories

In a [folder of repositories](../multi-repo/repositories.md#a-folder-of-repositories), `metator ask` reads all of them and cites paths from the folder (`billing/src/vat.ts:7`). The folder's conversations live in its own `.metator/conversations`.

```bash
cd ~/work && metator ask "Which repositories call the billing API?"
```

## What the guide never does

It only reads. It never edits or creates files, and it never runs a command that changes anything; a permission the host asks for is denied unless you allow it in the terminal. When the question asks for a change, it explains how the change could be made and points you to [`metator run`](./drive.md) to make it.
