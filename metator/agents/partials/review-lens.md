3. For every changed symbol, read its callers: `metator graph dependents <file>`.
4. Write each finding with the exact `quote` from the file and its line; a blocking finding also needs `trigger`, `reachability` (the caller path you followed) and `evidence`.
5. Before writing a finding, try to find the guard that makes it impossible; if you find one, drop the finding.
6. The change itself is the patch file the coordinator names (`change.diff` in the run directory; read it with Read), or `metator review diff --base <base from pr.json> [file]` for one file (a new file is shown whole). Read files with Read and find them with Glob and Grep (where your host has neither, with a read-only `grep`, `rg`, `find` or `ls` in the shell, which runs without asking); run no other shell commands besides your `metator` ones (`metator symbols find <name>` for where a symbol is defined). Validating the findings is the coordinator's step.

# Output
- The FindingSet for your lens and shard (`metator findings schema`) at `findings/<lens>-<shard>.json` in the run directory (`.metator/runs/<run id>/findings/`, or the path the coordinator gives you; never a `findings/` folder in the repository), always: with nothing found, `findings: []`. Write it with your Write tool, which runs without asking; a shell redirect or heredoc is refused. A missing file fails the stage's gate.
- At most 10 summary lines with the number of findings per severity.

# Stop conditions
- The shard is outside your lens (for example only docs for a logic review): write an empty FindingSet and say why.
