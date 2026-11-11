# Ask about the code

`metator ask` answers a question about the repository from the code, and cites the lines that support each claim. It starts no run and changes nothing.

## Ask

```bash
metator ask "How is the discount computed?"
```

A read-only agent, `mt-guide`, answers through your AI host. It finds the code with `metator symbols`, `metator similar` and `metator graph`, reads it, and cites every claim as `path:line`. In a terminal the answer appears as it is written. In a script you get it as JSON, with the citations as a list.

MetatorAI then checks every cited file. A citation of a file that does not exist comes back as a warning. Check that claim before you rely on it.

## Follow up

```bash
metator ask "Is there a cap?" --continue
metator ask "And for B2B orders?" --conversation 20261028-how-is-the-discount-computed
metator ask list
```

`--continue` follows up in the latest conversation and `--conversation` in the one you name. `ask list` shows every conversation, newest first. Conversations are kept in `.metator/conversations/`.

A follow-up continues the host's own session, so the agent remembers what it read. `--host` picks the host that answers: `claude`, `copilot` or `scenario`. If you switch hosts in a conversation, the new host gets the earlier questions and answers.

## Ask across repositories

In a [folder of repositories](../repo/repositories.md), `metator ask` reads all of them and cites paths from the folder, such as `billing/src/vat.ts:7`.

```bash
cd ~/work && metator ask "Which repositories call the billing API?"
```

The folder keeps its own conversations in its `.metator/conversations/`.

## What the agent may do

`mt-guide` only reads. It does not edit or create files, and it runs no command that changes anything. A read-only search through the shell (`grep`, `rg`, `find`, `ls` inside the repository) runs without asking. Any other permission the host asks for is denied unless you allow it in the terminal. Files that may hold secrets, such as `.env` files and keys, stay unread.

When your question asks for a change, the agent explains how the change could be made and points you to [Start a task](./index.md).
