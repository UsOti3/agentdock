@echo off
node "%~dp0bridge\manage.js" start
if errorlevel 1 pause
