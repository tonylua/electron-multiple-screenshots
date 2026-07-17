@echo off
REM Build napi native addon: screenshot.<triple>.node + index.js + index.d.ts
REM Loads MSVC + Windows SDK env via vcvars64, then builds with @napi-rs/cli.
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
call npx napi build --platform --release
