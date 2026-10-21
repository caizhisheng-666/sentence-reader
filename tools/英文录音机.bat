@echo off
chcp 65001 >nul
title 英文录音机
set "ACT="
for %%P in ("%USERPROFILE%\miniconda3" "%USERPROFILE%\anaconda3" "C:\ProgramData\miniconda3" "C:\ProgramData\anaconda3" "C:\miniconda3" "C:\anaconda3") do if exist "%%~P\Scripts\activate.bat" if not defined ACT set "ACT=%%~P\Scripts\activate.bat"
if not defined ACT (
  echo 没找到 conda（miniconda3 / anaconda3）。请把这个窗口截图发给 Claude。
  pause
  exit /b 1
)
call "%ACT%" tts-kokoro
cd /d "%~dp0"
python enrecorder.py %*
echo.
echo 英文录音机已停止。按任意键关闭窗口。
pause >nul
