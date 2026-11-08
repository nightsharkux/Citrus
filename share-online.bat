@echo off
title Campus OS - shared online
cd /d "%~dp0"
node --env-file-if-exists=.env scripts/share.js
pause
