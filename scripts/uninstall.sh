#!/bin/sh
# Removes cls-agent-observability. Customer config is never modified; if the
# plugin was added to plugins.allow, the user removes it manually.
set -eu

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
TARGET="$STATE_DIR/extensions/cls-agent-observability"

if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
  echo "Removed $TARGET"
else
  echo "Not installed at $TARGET"
fi

CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$STATE_DIR/openclaw.json}"
if [ -f "$CONFIG_PATH" ] && grep -q 'cls-agent-observability' "$CONFIG_PATH"; then
  echo "NOTE: $CONFIG_PATH still references cls-agent-observability (plugins.allow/entries); remove it manually."
fi
echo "Restart the gateway to unload."
