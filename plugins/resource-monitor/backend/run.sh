#!/bin/sh
# Resource monitor plugin backend launcher (Unix).
#
# The sampling script (sample.ps1) is Windows-only; on other platforms the
# backend still speaks the JSON-RPC protocol and reports a clear "unsupported"
# status in the UI instead of failing the handshake.
exec node "$(dirname "$0")/index.mjs"
