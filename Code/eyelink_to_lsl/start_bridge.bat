@echo off
REM Starts the EyeLink -> LSL bridge using the venv in this folder.
REM Usage: start_bridge.bat [run_bridge.py args...]
REM   e.g. start_bridge.bat --edf-filename sub01

setlocal

set "SCRIPT_DIR=%~dp0"
set "PYTHON_EXE=%SCRIPT_DIR%.venv\Scripts\python.exe"

if not exist "%PYTHON_EXE%" (
    echo [eyelink_to_lsl] venv not found at "%PYTHON_EXE%"
    echo Create it first from this folder:
    echo   python -m venv .venv
    echo   .venv\Scripts\pip install pylsl psychopy websockets
    echo   (plus the SR Research EyeLink Developer Kit's pylink on PYTHONPATH)
    pause
    exit /b 1
)

"%PYTHON_EXE%" "%SCRIPT_DIR%run_bridge.py" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [eyelink_to_lsl] bridge exited with code %EXIT_CODE%.
    pause
)

endlocal
exit /b %EXIT_CODE%
