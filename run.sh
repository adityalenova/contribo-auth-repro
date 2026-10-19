#!/usr/bin/env bash
# Run every check whose prerequisites are available, and say why the others were skipped.
set -uo pipefail

cd "$(dirname "$0")"

BASE_URL="${BASE_URL:-http://localhost:3000}"
MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017}"
ran=0
skipped=0

section() { printf '\n=== %s ===\n' "$1"; }

section "OAuth configuration checks (no prerequisites)"
node scripts/check-oauth-config.mjs || exit 1
ran=$((ran + 1))

if [ -d node_modules/mongodb ]; then
  section "Null-email index reproduction ($MONGODB_URI)"
  if MONGODB_URI="$MONGODB_URI" node scripts/repro-null-email.mjs; then
    ran=$((ran + 1))
  else
    echo "The reproduction exited non-zero - see the message above."
    exit 1
  fi
else
  echo "SKIP  index reproduction: run \`npm install\` first (needs the mongodb driver)."
  skipped=$((skipped + 1))
fi

if command -v python3 >/dev/null 2>&1; then
  section "HTTP smoke test ($BASE_URL)"
  host="${BASE_URL#*://}"
  probe="${host%%/*}"
  port="${probe##*:}"
  if (exec 3<>"/dev/tcp/${probe%:*}/${port:-80}") 2>/dev/null; then
    exec 3>&- 3<&-
    python3 tools/smoke_test.py "$BASE_URL" || exit 1
    ran=$((ran + 1))
  else
    echo "SKIP  smoke test: nothing is listening on $BASE_URL - start the app (npm run dev)."
    skipped=$((skipped + 1))
  fi
else
  echo "SKIP  smoke test: python3 not found."
  skipped=$((skipped + 1))
fi

printf '\nDone: %s check group(s) ran, %s skipped.\n' "$ran" "$skipped"
