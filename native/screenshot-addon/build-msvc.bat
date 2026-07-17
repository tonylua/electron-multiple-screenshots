@echo off
REM Plain cargo build under MSVC env (for quick type/link checks).
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
cargo build %*
