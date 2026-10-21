#!/bin/bash
# Installs the latest Sumitex release.
#   curl -fsSL https://raw.githubusercontent.com/nogu66/sumitex/main/install.sh | bash
# Set SUMI_INSTALL_DIR to install somewhere other than /Applications.
set -euo pipefail

REPO="nogu66/sumitex"
APP="Sumitex.app"

fail() {
  echo "error: $*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "Sumitex runs on macOS only."
[ "$(uname -m)" = "arm64" ] || fail "Sumitex needs a Mac with Apple silicon. On Intel Macs, build it from source: https://github.com/$REPO#build-from-source"

# The latest release redirects to .../releases/tag/v<version>
tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
tag=${tag##*/}
version=${tag#v}
[ -n "$version" ] && [ "$version" != "latest" ] || fail "could not find the latest release."

dir=${SUMI_INSTALL_DIR:-/Applications}
if [ -z "${SUMI_INSTALL_DIR:-}" ] && [ ! -w /Applications ]; then
  dir="$HOME/Applications"
fi
mkdir -p "$dir"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Sumitex $version..."
curl -fL --progress-bar -o "$tmp/sumi.zip" "https://github.com/$REPO/releases/download/$tag/Sumitex-$version-arm64-mac.zip"
ditto -x -k "$tmp/sumi.zip" "$tmp"

if [ -d "$dir/$APP" ] && pgrep -qf "$dir/$APP/Contents/MacOS/Sumitex"; then
  echo "Quitting the running Sumitex..."
  osascript -e 'tell application id "me.noguchy.sumitex" to quit' >/dev/null 2>&1 || true
  sleep 2
fi

rm -rf "${dir:?}/$APP"
ditto "$tmp/$APP" "$dir/$APP"
# The app is not notarized yet. curl does not mark downloads as quarantined, but clear it in case.
xattr -dr com.apple.quarantine "$dir/$APP" 2>/dev/null || true

echo "Installed Sumitex $version to $dir/$APP"

# Until 0.1.0 the app was called Sumi. Remove that copy; its settings move over on first launch.
old="$dir/Sumi.app"
if [ -d "$old" ] && [ "$(defaults read "$old/Contents/Info" CFBundleIdentifier 2>/dev/null)" = "me.noguchy.sumi" ]; then
  osascript -e 'tell application id "me.noguchy.sumi" to quit' >/dev/null 2>&1 || true
  rm -rf "$old"
  echo "Removed the old Sumi.app"
fi

if ! command -v latexmk >/dev/null 2>&1 && [ ! -x /Library/TeX/texbin/latexmk ]; then
  echo
  echo "Sumitex compiles with latexmk, which was not found. Install a TeX distribution, for example:"
  echo "  brew install --cask mactex-no-gui"
fi

echo
echo "Open it with: open \"$dir/$APP\""
