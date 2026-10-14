@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
rem Windows 7 track: package lifecycle scripts also run on Node 16, so the
rem polyfill preload and the node:sqlite / node:sea loader are added when the
rem compatibility runtime is present. Win10 keeps the original argument list.
set "DSH_WIN7_COMPAT=%DSH_WIN7_COMPAT_DIR%"
set "COMPAT_ARGS="
if exist "%DSH_WIN7_COMPAT%\polyfills.cjs" set COMPAT_ARGS=--require "%DSH_WIN7_COMPAT%\polyfills.cjs" --experimental-loader "%DSH_WIN7_COMPAT%\loader.mjs"
"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals %COMPAT_ARGS% %*
