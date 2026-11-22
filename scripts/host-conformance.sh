#!/bin/sh
# The host conformance suite (ADR-0098) against the real Claude Code and Copilot CLI, one after
# the other, from this checkout. For the product owner's machine: each host's CLI on PATH (or
# METATOR_CLAUDE_BIN / METATOR_COPILOT_BIN) and logged in. Never in tests or CI.
#
#   scripts/host-conformance.sh                 both hosts, then the diff of their reports
#   scripts/host-conformance.sh copilot         one host
#   scripts/host-conformance.sh claude --keep   options after the host go to the command
#
# Reports: .metator/conformance/conformance-<host>-<version>.json (and .md). Send the .json back.
set -u

cd "$(dirname "$0")/.." || exit 1
if [ "${METATOR_NO_REAL_HOSTS:-}" = "1" ]; then
  echo "METATOR_NO_REAL_HOSTS is set: the suite drives a real host. Unset it to run the suite." >&2
  exit 2
fi

hosts="claude copilot"
case "${1:-}" in
  claude|copilot) hosts="$1"; shift ;;
esac

status=0
reports=""
for host in $hosts; do
  echo "== $host: the conformance suite (this takes a while) ==" >&2
  out=$(bun packages/cli/src/main.ts host conformance --host "$host" --json "$@")
  code=$?
  report=$(printf '%s\n' "$out" | sed -n 's/.*"report":"\([^"]*\)".*/\1/p')
  if [ "$code" -ne 0 ] || [ -z "$report" ]; then
    echo "$host: the suite could not run (exit $code):" >&2
    printf '%s\n' "$out" >&2
    status=1
    continue
  fi
  summary=$(printf '%s\n' "$out" | sed -n 's/.*"passed":\([0-9]*\),"failed":\([0-9]*\),"skipped":\([0-9]*\).*/\1 passed, \2 failed, \3 skipped/p')
  echo "$host: $summary" >&2
  echo "$host: report $report" >&2
  echo "$host: readable ${report%.json}.md" >&2
  reports="$reports $report"
done

set -- $reports
if [ "$#" -eq 2 ]; then
  echo "== parity gaps: checks whose result differs ==" >&2
  bun packages/cli/src/main.ts host conformance diff "$1" "$2" --json
fi
exit "$status"
