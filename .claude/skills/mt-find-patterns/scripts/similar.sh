#!/bin/sh
# Ranked pattern occurrences for a planned file (--file <path>) or a description.
# METATOR overrides the command, e.g. METATOR="bun run metator".
exec ${METATOR:-metator} similar "$@"
