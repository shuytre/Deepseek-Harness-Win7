@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
rem Windows 7 track: the runtime ships a `--require` polyfill preload and an ESM
rem loader that redirects the built-ins Node 16 lacks (node:sqlite, node:sea).
set "DSH_WIN7_COMPAT=%~dp0..\..\win7-compat"
set "DSH_WIN7_MODULE_ROOTS=%~dp0..\..\..\app.asar.unpacked\dsh"
set "COMPAT_ARGS="
if exist "%DSH_WIN7_COMPAT%\polyfills.cjs" set COMPAT_ARGS=--require "%DSH_WIN7_COMPAT%\polyfills.cjs" --experimental-loader "%DSH_WIN7_COMPAT%\loader.mjs"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals %COMPAT_ARGS% "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
