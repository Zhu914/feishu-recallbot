#!/bin/sh
set -e
cd /app
mkdir -p logs outputs
rm -f .feishu-bot.pid
exec node src/index.js
