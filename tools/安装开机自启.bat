@echo off
chcp 65001 >nul
set "TARGET=%~dp0喵喵录音机.bat"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\喵喵录音机.bat"
> "%LNK%" echo @echo off
>> "%LNK%" echo chcp 65001 ^>nul
>> "%LNK%" echo start "" /min "%TARGET%"
echo 已设置：以后电脑开机后，喵喵录音机会自动在后台运行（任务栏里是个最小化的窗口）。
echo 想取消：删除这个文件即可：%LNK%
pause
