#!/bin/bash
# 配布用の zip と dmg を release/ に作る。手順は CONTRIBUTING.md の「Releasing」を参照。
# Apple の署名がまだないので ad-hoc で署名する（署名が崩れていると、macOS が「壊れている」と見なすため）。
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
app=release/mac-arm64/Sumitex.app
zip=release/Sumitex-$version-arm64-mac.zip

npm run dist
codesign --force --deep -s - "$app"
codesign --verify --deep --strict "$app"
rm -f "$zip" "release/Sumitex-$version-arm64.dmg"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
npx electron-builder --mac dmg --arm64 --prepackaged "$app"

echo
ls -lh "$zip" "release/Sumitex-$version-arm64.dmg"
echo "sha256 (zip, for the Homebrew cask): $(shasum -a 256 "$zip" | cut -d' ' -f1)"
