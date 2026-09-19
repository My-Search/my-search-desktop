@echo off
chcp 65001 >nul 2>nul
rem Pi Agent backend launcher.
rem
rem NOTE: keep this file ASCII-only. cmd.exe parses .cmd as GBK on Chinese
rem Windows, so UTF-8 comments get mangled into fake commands and node never
rem starts (symptom: host reports startup timeout).
rem
rem This launcher intentionally does NOT run npm install: pi plus its provider
rem SDKs is a very large dependency tree, and installing it here would blow
rem past the host handshake timeout. The backend instead reuses an existing pi
rem installation; see piModuleCandidates() in index.mjs.
rem
rem Set PI_CODING_AGENT_MODULE to an explicit dist/index.js path to override.
node "%~dp0index.mjs"
