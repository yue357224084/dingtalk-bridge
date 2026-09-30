@echo off
rem 同机模式：在本机常驻运行桥接（崩溃自动拉起）
rem 可手动运行，或由任务计划调用（见 setup-task.ps1）。路径按脚本位置自动定位。
cd /d "%~dp0..\..\bridge"
:loop
python -u bridge.py >> bridge.stdout.log 2>&1
timeout /t 10 /nobreak >nul
goto loop
