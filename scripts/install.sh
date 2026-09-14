#!/bin/sh
# Installs cls-agent-observability into the OpenClaw extensions directory.
# Plugins dropped there are auto-discovered and enabled by default.
set -eu

BASE_URL="${CLS_OBS_COS_BASE_URL:-https://BUCKET.cos.REGION.myqcloud.com/cls-agent-observability}"
VERSION="${1:-latest}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
TARGET="$STATE_DIR/extensions/cls-agent-observability"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading cls-agent-observability $VERSION from $BASE_URL ..."
curl -fsSL --connect-timeout 15 --max-time 600 "$BASE_URL/$VERSION/plugin.tar.gz" -o "$TMP/plugin.tar.gz"
curl -fsSL --connect-timeout 15 --max-time 60 "$BASE_URL/$VERSION/SHA256SUMS" -o "$TMP/SHA256SUMS"

# sha256sum on Linux, shasum on macOS. The checksum file names the distributed
# artifact (plugin.tar.gz), which is what we saved it as.
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$TMP" && sha256sum -c SHA256SUMS)
else
  (cd "$TMP" && shasum -a 256 -c SHA256SUMS)
fi

# Upgrade-safe: clear stale files only after the checksum passed.
rm -rf "$TARGET"
mkdir -p "$TARGET"
tar -xzf "$TMP/plugin.tar.gz" -C "$TARGET"
echo "Installed to $TARGET"

# Two config facts gate this plugin on every host:
#  1. plugins.allow, when configured, is a whitelist: this plugin must be in it.
#  2. Non-bundled plugins get NO conversation-content hooks (llm_input,
#     before_agent_run, message_*) unless their entry sets
#     hooks.allowConversationAccess=true — without it the plugin loads but
#     produces nothing.
# The CLI does structured JSON5 reads; config patch REPLACES arrays, so both
# allow (array) and entries (object) are merged from the current values, never
# written blind.
if command -v openclaw >/dev/null 2>&1; then
  ALLOW_JSON="$(openclaw config get plugins.allow --json 2>/dev/null || true)"
  ENTRIES_JSON="$(openclaw config get plugins.entries --json 2>/dev/null || true)"
  # node reads the current values and writes the merged patch file itself: no
  # shell expansion of config content, and a parse failure falls through to the
  # WARN instead of aborting the script under set -e.
  if printf '%s\n%s\n' "$ALLOW_JSON" "$ENTRIES_JSON" | node -e '
    const fs = require("node:fs");
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const [allowRaw, entriesRaw] = s.split("\n");
      let allow;
      try {
        allow = JSON.parse(allowRaw || "null");
      } catch {
        allow = null;
      }
      let entries;
      try {
        entries = JSON.parse(entriesRaw || "null");
      } catch {
        entries = null;
      }
      const plugins = {};
      if (Array.isArray(allow) && allow.length > 0) {
        if (!allow.includes("cls-agent-observability")) {
          allow.push("cls-agent-observability");
        }
        plugins.allow = allow;
      }
      const merged =
        entries && typeof entries === "object" && !Array.isArray(entries)
          ? { ...entries }
          : {};
      merged["cls-agent-observability"] = {
        enabled: true,
        hooks: { allowConversationAccess: true },
      };
      plugins.entries = merged;
      fs.writeFileSync(process.argv[1], JSON.stringify({ plugins }) + "\n");
    });
  ' "$TMP/patch.json5"; then
    openclaw config patch --file "$TMP/patch.json5" || \
      echo "WARN: could not apply plugin config; see the manual snippet below"
  else
    echo "WARN: could not merge plugin config; see the manual snippet below"
  fi
else
  cat <<'EOF'
NOTE: openclaw CLI not found. Add this to your openclaw.json manually:

  "plugins": {
    "entries": {
      "cls-agent-observability": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }

Without hooks.allowConversationAccess the plugin loads but reports nothing.
EOF
fi

cat <<'EOF'

Next: configure the exporter and restart the gateway.

  export CLS_ENDPOINT=https://<region>.cls.tencentcs.com
  export CLS_TRACE_TOPIC_ID=<trace topic id>
  export CLS_SECRET_ID=...
  export CLS_SECRET_KEY=...
  export CLS_CONTENT_MODE=truncate   # recommended
EOF
