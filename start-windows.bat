@echo off
title Campus OS
cd /d "%~dp0"
node --env-file-if-exists=.env server.js
pause
