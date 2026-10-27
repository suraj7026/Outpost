#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release
PRODUCTS="$(swift build -c release --show-bin-path)"
APP="build/Outpost.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$PRODUCTS/Outpost" "$APP/Contents/MacOS/Outpost"
cp -R "$PRODUCTS/OutpostClients_OutpostKit.bundle" "$APP/Contents/Resources/"
/usr/libexec/PlistBuddy -c 'Clear dict' -c 'Add :CFBundleIdentifier string dev.outpost.mac' -c 'Add :CFBundleName string Outpost' -c 'Add :CFBundleExecutable string Outpost' -c 'Add :CFBundlePackageType string APPL' -c 'Add :LSMinimumSystemVersion string 14.0' -c 'Add :NSFaceIDUsageDescription string Authenticate exact Outpost decisions.' "$APP/Contents/Info.plist" >/dev/null
codesign --force --deep --sign - "$APP"
printf 'Built %s\n' "$APP"
