#!/bin/sh
# Smoke test for scripts/install.sh against a file:// fake COS.
# Run from the repo root after `npm run pack:dist`.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAKE_COS=/tmp/cls-obs-test-cos
FAKE_STATE=/tmp/cls-obs-test-state
rm -rf "$FAKE_COS" "$FAKE_STATE"
mkdir -p "$FAKE_COS/latest" "$FAKE_STATE"

TARBALL="$(ls "$ROOT"/dist/cls-agent-observability-*.tar.gz | head -1)"
cp "$TARBALL" "$FAKE_COS/latest/plugin.tar.gz"
cp "$ROOT/dist/SHA256SUMS" "$FAKE_COS/latest/SHA256SUMS"

echo "--- install ---"
CLS_OBS_COS_BASE_URL="file://$FAKE_COS" OPENCLAW_STATE_DIR="$FAKE_STATE" \
  sh "$ROOT/scripts/install.sh"

test -f "$FAKE_STATE/extensions/cls-agent-observability/index.mjs"
test -f "$FAKE_STATE/extensions/cls-agent-observability/openclaw.plugin.json"

echo "--- tamper must be rejected ---"
echo "tampered" >> "$FAKE_COS/latest/plugin.tar.gz"
rm -rf "$FAKE_STATE/extensions"
if CLS_OBS_COS_BASE_URL="file://$FAKE_COS" OPENCLAW_STATE_DIR="$FAKE_STATE" \
  sh "$ROOT/scripts/install.sh" 2>/dev/null; then
  echo "FAIL: tampered tarball was installed"
  exit 1
fi
test ! -d "$FAKE_STATE/extensions/cls-agent-observability"

echo "--- uninstall ---"
# Reinstall a clean copy, then remove it.
cp "$TARBALL" "$FAKE_COS/latest/plugin.tar.gz"
CLS_OBS_COS_BASE_URL="file://$FAKE_COS" OPENCLAW_STATE_DIR="$FAKE_STATE" \
  sh "$ROOT/scripts/install.sh" >/dev/null
OPENCLAW_STATE_DIR="$FAKE_STATE" OPENCLAW_CONFIG_PATH="$FAKE_STATE/openclaw.json" \
  sh "$ROOT/scripts/uninstall.sh"
test ! -d "$FAKE_STATE/extensions/cls-agent-observability"

echo "--- allow/entries merge with stub CLI ---"
# Stub openclaw: `config get plugins.allow --json` returns an existing
# whitelist, `config get plugins.entries --json` an existing entry;
# `config patch --file` records the payload.
STUB=/tmp/cls-obs-test-stub
rm -rf "$STUB"
mkdir -p "$STUB"
cat > "$STUB/openclaw" <<'SH'
#!/bin/sh
if [ "$1 $2" = "config get" ]; then
  case "$3" in
    plugins.allow) echo '["existing-plugin"]' ;;
    plugins.entries) echo '{"existing-plugin":{"enabled":true}}' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "patch" ]; then
  cp "$4" /tmp/cls-obs-test-patch.json
  exit 0
fi
exit 1
SH
chmod +x "$STUB/openclaw"

rm -rf "$FAKE_STATE/extensions"
rm -f /tmp/cls-obs-test-patch.json
PATH="$STUB:$PATH" CLS_OBS_COS_BASE_URL="file://$FAKE_COS" OPENCLAW_STATE_DIR="$FAKE_STATE" \
  sh "$ROOT/scripts/install.sh" >/dev/null

test -f /tmp/cls-obs-test-patch.json
node -e '
const patch = require("/tmp/cls-obs-test-patch.json");
const allow = patch.plugins.allow;
if (!allow.includes("existing-plugin")) throw new Error("existing whitelist entry lost");
if (!allow.includes("cls-agent-observability")) throw new Error("plugin not added to allow");
const entries = patch.plugins.entries;
if (!entries["existing-plugin"]) throw new Error("existing entries entry lost");
const ours = entries["cls-agent-observability"];
if (!ours || ours.enabled !== true) throw new Error("our entry missing or disabled");
if (ours.hooks?.allowConversationAccess !== true)
  throw new Error("hooks.allowConversationAccess not granted — typed hooks would be blocked");
console.log("allow+entries merge OK");
'

echo "install.test.sh OK"
