#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release
app="$PWD/build/Outpost Mock.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
bin_dir="$(swift build -c release --show-bin-path)"
cp "$bin_dir/OutpostMock" "$app/Contents/MacOS/OutpostMock"
cp -R "$bin_dir/OutpostMock_OutpostMock.bundle" "$app/Contents/Resources/"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Outpost Mock</string>
<key>CFBundleDisplayName</key><string>Outpost Mock</string>
<key>CFBundleIdentifier</key><string>com.outpost.designmock</string>
<key>CFBundleExecutable</key><string>OutpostMock</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$app"
echo "Built: $app"
