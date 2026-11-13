@echo off
setlocal enabledelayedexpansion

:: Loop through all files in the current directory
for %%F in (*.*) do (
    :: Store the filename and extension
    set "filename=%%~nxF"
    
    :: Skip the batch script itself so it doesn't rename itself
    if not "%%~nxF"=="%~nx0" (
        :: Replace spaces with underscores
        set "newname=!filename: =_!"
        
        :: If the name actually changed, perform the rename
        if not "!filename!"=="!newname!" (
            ren "%%~nxF" "!newname!"
        )
    )
)

echo Done renaming files!
pause
