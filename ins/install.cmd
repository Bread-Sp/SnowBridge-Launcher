@echo off
chcp 65001 >nul
setlocal
rem 安装程序入口：用 STA 的 PowerShell 跑图形安装界面（参数会透传，支持 -Silent）
powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -WindowStyle Normal -File "%~dp0install.ps1" %*
set RC=%errorlevel%
exit /b %RC%
