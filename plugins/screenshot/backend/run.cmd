@echo off
rem Screenshot plugin backend launcher (Windows).
rem
rem NOTE: keep this file ASCII-only. cmd.exe parses .cmd as GBK on Chinese
rem Windows, so UTF-8 comments get mangled into fake commands and node never
rem starts (symptom: host reports startup timeout).
rem
rem This launcher intentionally does NOT run npm install: the backend has
rem zero npm dependencies (only node: builtins + PowerShell).
node "%~dp0index.mjs"
