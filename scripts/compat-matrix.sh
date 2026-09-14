#!/bin/sh
# Compatibility gate: runs the bundle smoke on every supported host version.
# Hosts are fetched from npm on first run (not vendored in git); a stamp file
# makes the fetch re-entrant — an interrupted fetch is redone, not skipped.
#
# Requires DEEPSEEK_API_KEY (the smoke drives a real model).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "DEEPSEEK_API_KEY is required (the smoke runs a real model)" >&2
  exit 2
fi

# fetch_host <version> <dir>: lays out the npm package so its launcher works —
# openclaw.mjs is a shim importing ./dist/entry.js; workspace templates resolve
# via docs/reference/templates (and src/agents/templates for HEARTBEAT.md).
fetch_host() {
  version="$1"
  dir="$2"
  stamp="$dir/.fetch-complete"
  [ -f "$stamp" ] && return 0
  echo "fetching openclaw@$version ..."
  tmp="$(mktemp -d)"
  (cd "$tmp" && npm pack "openclaw@$version" --silent && tar -xzf openclaw-*.tgz)
  mkdir -p "$dir/docs"
  cp "$tmp/package/openclaw.mjs" "$tmp/package/package.json" "$dir/"
  cp -r "$tmp/package/dist" "$dir/"
  cp -r "$tmp/package/docs/reference" "$dir/docs/"
  cp -r "$tmp/package/src" "$dir/"
  (cd "$dir" && npm install --omit=dev --legacy-peer-deps --ignore-scripts)
  rm -rf "$tmp"
  touch "$stamp"
}

fetch_host 2026.6.5 "$ROOT/.cache/openclaw-v2026.6.5"
fetch_host 2026.7.1-2 "$ROOT/.cache/openclaw-v2026.7.1"

for bin in "$ROOT/.cache/openclaw-v2026.6.5/openclaw.mjs" "$ROOT/.cache/openclaw-v2026.7.1/openclaw.mjs"; do
  echo "=== host: $bin ==="
  E2E_OPENCLAW_BIN="$bin" node "$ROOT/scripts/smoke-bundle.cjs"
done
echo "compat matrix OK"
