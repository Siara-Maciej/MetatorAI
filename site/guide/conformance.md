# Host conformance

MetatorAI treats GitHub Copilot CLI and Claude Code as equals: what MetatorAI does with one host it must do with the other, or not at all. The host conformance suite checks that on the real programs. It runs the same checks against each host's own CLI and writes a report you can read without logging in to anything, and send back.

The suite needs a real, logged-in host, so it never runs in tests or CI. You run it on your own machine.

## What it does

`metator host conformance --host claude` (or `--host copilot`):

1. Makes a throwaway git repository in your temporary directory and sets it up with `metator setup --host <host> --yes`.
2. Starts a daemon of its own in it (`metator serve` on a free port), so nothing touches your own daemon, panes or runs.
3. Opens a chat in a pane, exactly as you do in the app (a new thread with the conversation agent), and later a session of a run. It types into them, answers their questions through the inbox, and uses `metator session tell` and `metator session interrupt`, as you would.
4. Plays the checks below, one after the other. A failed check never stops the suite. Each check has a time limit (`--timeout`, 180 seconds by default).
5. Stops the daemon and the host, deletes the repository (unless `--keep`), and writes the report.

Every check proves its claim through what MetatorAI itself observes: the pane's screen as drawn, the pane's state, the questions in the inbox, the guard's records, the consents you gave, the host's session id and git. Words a check expects back are the uppercase form of a word the session was shown in lowercase, so only an agent that read and acted can print them.

While it runs, the suite answers **No** to any approval prompt no check waits for, and notes it. The only **Yes** it ever gives is to a host's first-run question to trust the throwaway repository it made. Commits happen only in that repository, and nothing is pushed.

## Run it

You need:

- A checkout of MetatorAI with `bun install` done.
- The host's CLI on your `PATH` (`claude` or `copilot`) and logged in. Another program can be named with `METATOR_CLAUDE_BIN` or `METATOR_COPILOT_BIN`.
- `METATOR_NO_REAL_HOSTS` unset. Where it is set (the test suites set it), the suite refuses: "the conformance suite drives a real host; unset METATOR_NO_REAL_HOSTS to run it".

From the MetatorAI checkout, run both hosts in turn:

```bash
scripts/host-conformance.sh
```

It runs `metator host conformance` for Claude Code, then for Copilot CLI, prints where each report is and ends with the diff of the two. Name one host to run only it: `scripts/host-conformance.sh copilot`. Options after the host go to the command.

Or run one host yourself:

```bash
bun run metator host conformance --host copilot
```

A full run takes between ten and twenty-five minutes, and uses the host's model like any session.

| Option | What it does |
|---|---|
| `--host claude\|copilot` | The host whose real CLI is driven. OpenCode and the scenario host also run, but they are not expected to pass. |
| `--only <ids>` | Only these checks, comma-separated; the others are recorded as `skipped`. |
| `--out <dir>` | Where the report goes (default `.metator/conformance` in the repository you run it from). |
| `--keep` | Keep the throwaway repository and the daemon's log (`daemon.log` next to it) for a look afterwards. |
| `--timeout <seconds>` | How long one check may take (default 180). |
| `--settle <ms>` | How long the session stays idle at its prompt before its turn counts as over (default 4000). |

## The checks

| Check | What passing proves |
|---|---|
| `start` | The host starts as a thread's chat in a pane the daemon owns, answers a one-line prompt and comes to rest at its prompt. |
| `session-id` | The pane holds the host's own id of its session, the one a resume names. |
| `resume` | After the daemon is killed (SIGKILL) and started again without restoring, the pane is paused, continues in the same session (same id), and the agent still knows a word it was told before. |
| `hook-pre-tool-deny` | The host runs the pre-tool hook before a shell command and honours its deny: the guard kept the denial of `git reset --hard`, and the repository is unchanged. |
| `hook-pre-tool-ask` | The host honours the hook's `ask` with its own approval prompt. It reaches the inbox as a pane question with the command and the guard's reason; answered No there, nothing is committed. |
| `word-consent` | Your message "commit it" goes through the user-prompt hook, which keeps your consent; the next `git commit` uses it and runs without a prompt. |
| `unprompted-allow` | The host honours the hook's `allow`: `metator rules list` and `git status` run without the host asking. |
| `text-question` | A question the agent asks as plain text with lettered choices reaches the inbox as a pane question with those choices, and the answer given there reaches the agent. |
| `mcp-or-tools` | A MetatorAI command the agent files allow (`metator thread show`) runs from the session, and its answer comes back to the agent. |
| `tell` | Your words told to a run's idle session (`metator session tell`) are typed into it, and the agent acts on them. |
| `interrupt` | While the agent works on a long task, `metator session interrupt` stops it and the new words are taken: the long task never ends. |

## The report

Each run writes two files to the output directory:

- `conformance-<host>-<version>.json`: a `HostConformance` document (version 1). It holds the host, the CLI's version, the operating system, MetatorAI's version, when the run started and ended, and for each check its `id`, `title`, `result` (`pass`, `fail` or `skipped`), `evidence` and `tookMs`. The evidence is at most 2000 characters: the screen lines, the guard's records and the questions that prove the result, or what was there instead.
- `conformance-<host>-<version>.md`: the same as a page to read.

The report holds no credentials, and the throwaway repository held nothing of yours. To send a run back, attach the `.json` file.

## Compare two hosts

```bash
bun run metator host conformance diff .metator/conformance/conformance-claude-2.1.0.json conformance-copilot-1.0.114.json
```

It lists every check whose result differs between the two runs. That list is the set of parity gaps. A check that passes on one host and fails on the other is a gap to close in that host's adapter. If it cannot be closed, the feature is dropped for both hosts. That decision is the product owner's; the suite only reports.

How each adapter starts its host (`--session-id` and `--permission-mode` for Claude Code, `--deny-tool`, `--allow-tool` and `--continue` for Copilot CLI) stays inside the adapter, as long as every check observes the same result on both hosts.

## What to expect from Copilot CLI

As far as GitHub's documentation of Copilot hooks goes at the time of writing, a `preToolUse` hook may answer `allow`, `deny` or `ask`, but only `deny` is acted on. If that still holds, `hook-pre-tool-ask` and `unprompted-allow` fail on Copilot CLI; MetatorAI's adapter already passes the guard's allow list to Copilot as `--allow-tool` and its `never` list as `--deny-tool`. Copilot also names its sessions itself and tells nobody: MetatorAI holds `continue` for them and resumes the directory's latest session, so `session-id` fails today. A run of the suite settles each of these.

## In metator doctor

When a run of the suite is kept in `.metator/conformance/`, `metator doctor` gives a line per host:

```text
✓ conformance  last passed with claude 2.1.0 on 2026-11-22
! conformance  last passed with copilot 1.0.114 on 2026-11-21; copilot 1.0.99 installed here is older
```

A host installed in an older version than the last one that passed is a warning only. A host whose runs never passed gets a warning with the command that runs the suite again.

## Related

- [Copilot and Claude Code](./hosts.md): what MetatorAI generates for each host.
- [Hooks and guardrails](../repo/hooks.md): the guard the hook checks prove.
- [Documents and schemas](../reference/documents.md): `HostConformance`.
