#!/bin/sh
# Pi Agent backend launcher (same contract as run.cmd: never installs deps,
# reuses an existing pi installation; see piModuleCandidates() in index.mjs).
exec node "$(dirname "$0")/index.mjs"
