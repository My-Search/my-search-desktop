#!/bin/sh
# GitHub repo search & batch downloader backend launcher (macOS / Linux).
# The backend has zero npm dependencies and only needs Node.js 18+.
exec node "$(dirname "$0")/index.mjs"
