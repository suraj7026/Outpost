#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
platform="${1:-phone}"
[[ "$platform" == phone ]] || { echo 'Usage: test-native-ui.sh [phone] (iPhone simulator only)' >&2; exit 1; }
if lsof -tiTCP:4318 -sTCP:LISTEN >/dev/null; then
  echo 'Port 4318 is occupied. Stop your development coordinator before running the isolated UI fixture.' >&2
  exit 1
fi
: "${OUTPOST_SIMULATOR_ID:?Set OUTPOST_SIMULATOR_ID from xcrun simctl list devices available}"
scheme=OutpostPhone
destination="platform=iOS Simulator,id=$OUTPOST_SIMULATOR_ID"
root=$(mktemp -d /tmp/outpost-native-fixture.XXXXXX)
OUTPOST_DATA="$root" OUTPOST_PAIRING_TOKEN=outpost-ui-fixture-token-0123456789 node --import tsx server/main.ts >"$root/server.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; echo "Fixture evidence: $root"' EXIT
for ((i=0; i<50; i++)); do
  curl -fsS http://127.0.0.1:4318/health >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS http://127.0.0.1:4318/health >/dev/null
cd clients
xcodegen generate
xcodebuild -project Outpost.xcodeproj -scheme "$scheme" -disableAutomaticPackageResolution -skipPackageUpdates -parallel-testing-enabled NO -destination "$destination" -derivedDataPath "build/$platform" -resultBundlePath "build/$scheme-$(date +%Y%m%d-%H%M%S).xcresult" CODE_SIGN_IDENTITY=- test
