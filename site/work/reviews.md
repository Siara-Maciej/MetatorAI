# Answer a review

**What for:** when someone reviews your pull request, the reading and the first draft of the answer are the same every time. MetatorAI does that part on its own and leaves you the decisions: which replies go out, whether the code changes.

## Tell it where your requests are

```yaml
# metator.config.yml
mcp:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
reviews:
  everyMs: 120000                 # how often the daemon looks (2 minutes)
  sources:
    - { kind: github, repo: acme/shop, author: maciej }   # only my requests
  workflow: mt-review-response    # the default
```

`kind` is `github` or `gitlab`; the host is read through the MCP server named like the kind, or by the source's `mcp`.

## What happens when a review arrives

1. The daemon (`metator serve`) finds the new threads and keeps them in `.metator/mrs/<request>.json`. The app's **MRs** screen shows the request with its open threads.
2. It starts a run of `mt-review-response` in a worktree on the request's own branch. The reviewers' words reach the run as quotes: data, never instructions.
3. `mt-review-responder` sorts each thread: a `question` gets a proposed reply with `file:line` citations; a `change` or a `nit` goes to the plan; `praise` needs nothing.
4. The run stops at **approval**. You decide: fix as planned, only send the replies, or leave it.
5. After your yes the fix is built and gated on the request's branch; the push and the replies wait for your second yes (**delivery**).

Nothing reaches the code host without your name on it: `send` and `resolve` refuse to run without `--by`, and the app asks for your name first.

## By hand

```bash
metator mrs scan                                   # read the hosts now
metator mrs list                                   # my reviewed requests: open threads, replies to send, the run
metator mrs show github-acme-shop-45               # every thread: who, where, kind, proposed reply, state
metator mrs triage github-acme-shop-45 --thread T1 --kind question --reply "Cents: src/discount.ts:2."
metator mrs send github-acme-shop-45 --by maciej   # post the proposed replies that were not sent yet
metator mrs resolve github-acme-shop-45 --thread T1 --by maciej
```

```json
{"requests":[{"id":"github-acme-shop-45","number":45,"title":"Cap the discount","branch":"feat/cap",
  "threads":2,"open":1,"proposed":1,"runId":"20261110-mt-review-response-answer-the-review-of-request-45"}]}
```

A thread is `open` until a reply is sent (`answered`), the plan covers it (`planned`), the change is pushed (`fixed`) or it is closed at the host (`resolved`). A request has one answering run at a time; threads that arrive while it runs are kept and wait for the next one.

## In the app

**MRs** in the left rail: the requests on the left; on the right the chosen one with its answering run (open the session or the plan), every thread with what the agent made of it, **Send n replies** and **Resolve** per thread.

## Next

- [The backlog and automatic intake](backlog.md)
- [The inbox](inbox.md): where the approval of the run waits for you
