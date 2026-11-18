#!/bin/sh
set -e
cd /app

# Runtime state lives outside the image so container replacement and migration
# preserve the allowlist and bot dedup state.
DATA_DIR="${DATA_DIR:-/data}"
CONTACTS_FILE="${CONTACTS_FILE:-$DATA_DIR/contacts.md}"

mkdir -p logs outputs "$DATA_DIR" "$(dirname "$CONTACTS_FILE")"
if [ ! -f "$CONTACTS_FILE" ]; then
  cp session/knowledge/contacts.md "$CONTACTS_FILE"
fi
export CONTACTS_FILE

# Zhipu key for Managed Agents moderation: mount .secrets/zhipu.key or set ZHIPUAI_API_KEY.
if [ -f /run/secrets/zhipu_key ]; then
  export ZHIPUAI_API_KEY="$(cat /run/secrets/zhipu_key)"
fi

rm -f .feishu-bot.pid
exec "$@"
