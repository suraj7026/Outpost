#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
npx tauri build --bundles app "$@"
app='src-tauri/target/release/bundle/macos/Outpost Desktop.app'
# Local builds need a complete bundle seal, not just the Mach-O ad-hoc signature.
# Respect an explicitly configured distribution signing identity.
if [[ -z ${APPLE_SIGNING_IDENTITY:-} ]]; then
  codesign --force --deep --sign - "$app"
fi
codesign --verify --deep --strict "$app"
