@echo off
title Citrus - shared online
cd /d "%~dp0"
node --env-file-if-exists=.env scripts/share.js
pause
