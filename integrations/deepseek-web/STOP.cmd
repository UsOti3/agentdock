@echo off
node "%~dp0bridge\manage.js" stop
if errorlevel 1 pause
