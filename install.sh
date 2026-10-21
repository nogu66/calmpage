#!/bin/bash
# Installs the latest Sumi TeX release.
#   curl -fsSL https://raw.githubusercontent.com/nogu66/sumitex/main/install.sh | bash
# Set SUMI_INSTALL_DIR to install somewhere other than /Applications.
set -euo pipefail

REPO="nogu66/sumitex"
APP="Sumi.app"

fail() {
  echo "error: $*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "Sumi TeX runs on macOS only."
[ "$(uname -m)" = "arm64" ] || fail "Sumi TeX needs a Mac with Apple silicon. On Intel Macs, build it from source: https://github.com/$REPO#build-from-source"

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

echo "Downloading Sumi TeX $version..."
curl -fL --progress-bar -o "$tmp/sumi.zip" "https://github.com/$REPO/releases/download/$tag/Sumi-$version-arm64-mac.zip"
ditto -x -k "$tmp/sumi.zip" "$tmp"

if [ -d "$dir/$APP" ] && pgrep -qf "$dir/$APP/Contents/MacOS/Sumi"; then
  echo "Quitting the running Sumi TeX..."
  osascript -e 'tell application id "me.noguchy.sumi" to quit' >/dev/null 2>&1 || true
  sleep 2
fi

rm -rf "${dir:?}/$APP"
ditto "$tmp/$APP" "$dir/$APP"
# The app is not notarized yet. curl does not mark downloads as quarantined, but clear it in case.
xattr -dr com.apple.quarantine "$dir/$APP" 2>/dev/null || true

echo "Installed Sumi TeX $version to $dir/$APP"

if ! command -v latexmk >/dev/null 2>&1 && [ ! -x /Library/TeX/texbin/latexmk ]; then
  echo
  echo "Sumi TeX compiles with latexmk, which was not found. Install a TeX distribution, for example:"
  echo "  brew install --cask mactex-no-gui"
fi

echo
echo "Open it with: open \"$dir/$APP\""
