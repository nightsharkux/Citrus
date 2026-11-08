#!/bin/sh
cd "$(dirname "$0")"
if [ -f .env ]; then node --env-file=.env server.js; else node server.js; fi
