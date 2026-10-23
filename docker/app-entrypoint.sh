#!/bin/sh
set -e
cd /app

# Runtime state lives outside the image so container replacement and migration
# preserve the allowlist, scheduled tasks, Codex auth, bot sessions, and files.
DATA_DIR="${DATA_DIR:-/data}"
CONTACTS_FILE="${CONTACTS_FILE:-$DATA_DIR/contacts.md}"
TASKS_FILE="${TASKS_FILE:-$DATA_DIR/tasks.json}"

mkdir -p logs outputs "$DATA_DIR" "$(dirname "$CONTACTS_FILE")" "$(dirname "$TASKS_FILE")"
if [ ! -f "$CONTACTS_FILE" ]; then
  cp session/knowledge/contacts.md "$CONTACTS_FILE"
fi
if [ ! -f "$TASKS_FILE" ]; then
  cp tasks.json "$TASKS_FILE"
fi
export CONTACTS_FILE TASKS_FILE

rm -f .feishu-bot.pid
exec "$@"
