@echo off
chcp 65001 >nul 2>nul
rem GitHub File Upload plugin backend launcher.
rem
rem NOTE: keep this file ASCII-only. cmd.exe parses .cmd as GBK on Chinese
rem Windows, so UTF-8 comments get mangled into fake commands and node never
rem starts (symptom: host reports startup timeout).
rem
rem This launcher intentionally does NOT run npm install: the backend has
rem zero npm dependencies.
node "%~dp0index.mjs"
