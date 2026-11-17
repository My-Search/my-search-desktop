#!/bin/sh
# App Uninstaller plugin backend launcher (non-Windows hosts).
# The backend itself only supports Windows; this keeps the manifest portable.
exec node "$(dirname "$0")/index.mjs"
