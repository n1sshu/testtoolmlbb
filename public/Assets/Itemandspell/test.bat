@echo off
setlocal enabledelayedexpansion

:: Loop through all files in the current directory containing spaces
for %%F in ("* *") do (
    set "filename=%%~nxF"
    set "safename=!filename: =_!"
    ren "%%F" "!safename!"
)

echo Done renaming files.
pause
