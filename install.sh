#!/bin/bash
# Installs the latest Calmpage release.
#   curl -fsSL https://raw.githubusercontent.com/nogu66/calmpage/main/install.sh | bash
# Set CALMPAGE_INSTALL_DIR to install somewhere other than /Applications.
set -euo pipefail

REPO="nogu66/calmpage"
APP="Calmpage.app"

fail() {
  echo "error: $*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "Calmpage runs on macOS only."
[ "$(uname -m)" = "arm64" ] || fail "Calmpage needs a Mac with Apple silicon. On Intel Macs, build it from source: https://github.com/$REPO#build-from-source"

# The latest release redirects to .../releases/tag/v<version>
tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
tag=${tag##*/}
version=${tag#v}
[ -n "$version" ] && [ "$version" != "latest" ] || fail "could not find the latest release."

dir=${CALMPAGE_INSTALL_DIR:-/Applications}
if [ -z "${CALMPAGE_INSTALL_DIR:-}" ] && [ ! -w /Applications ]; then
  dir="$HOME/Applications"
fi
mkdir -p "$dir"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Calmpage $version..."
curl -fL --progress-bar -o "$tmp/calmpage.zip" "https://github.com/$REPO/releases/download/$tag/Calmpage-$version-arm64-mac.zip"
ditto -x -k "$tmp/calmpage.zip" "$tmp"

if [ -d "$dir/$APP" ] && pgrep -qf "$dir/$APP/Contents/MacOS/Calmpage"; then
  echo "Quitting the running Calmpage..."
  osascript -e 'tell application id "me.noguchy.calmpage" to quit' >/dev/null 2>&1 || true
  sleep 2
fi

rm -rf "${dir:?}/$APP"
ditto "$tmp/$APP" "$dir/$APP"
# The app is not notarized yet. curl does not mark downloads as quarantined, but clear it in case.
xattr -dr com.apple.quarantine "$dir/$APP" 2>/dev/null || true

echo "Installed Calmpage $version to $dir/$APP"

# The app was called Sumitex until 0.2.0 and Sumi until 0.1.0. Remove those copies; their settings move over on first launch.
for name in Sumitex Sumi; do
  old="$dir/$name.app"
  id="me.noguchy.$(echo "$name" | tr '[:upper:]' '[:lower:]')"
  if [ -d "$old" ] && [ "$(defaults read "$old/Contents/Info" CFBundleIdentifier 2>/dev/null)" = "$id" ]; then
    osascript -e "tell application id \"$id\" to quit" >/dev/null 2>&1 || true
    rm -rf "$old"
    echo "Removed the old $name.app"
  fi
done

if ! command -v latexmk >/dev/null 2>&1 && [ ! -x /Library/TeX/texbin/latexmk ]; then
  echo
  echo "Calmpage compiles with latexmk, which was not found. Install a TeX distribution, for example:"
  echo "  brew install --cask mactex-no-gui"
fi

echo
echo "Open it with: open \"$dir/$APP\""
