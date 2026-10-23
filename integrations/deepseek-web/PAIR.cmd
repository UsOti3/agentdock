@echo off
node "%~dp0bridge\manage.js" pair
if errorlevel 1 pause
