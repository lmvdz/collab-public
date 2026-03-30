#!/bin/bash
set -euo pipefail

REPO="collaborator-ai/collab-public"
TMP_DIR=$(mktemp -d)

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

fetch_latest_release_json() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest"
}

pick_asset_url() {
  local release_json="$1"
  local pattern="$2"
  printf '%s' "$release_json" \
    | grep -o "\"browser_download_url\": *\"[^\"]*${pattern}\"" \
    | head -1 \
    | cut -d'"' -f4
}

echo "Fetching latest release..."
RELEASE_JSON=$(fetch_latest_release_json)
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin)
    if [ "$ARCH" != "arm64" ]; then
      echo "Error: the command-line installer currently supports macOS Apple Silicon only." >&2
      exit 1
    fi

    ASSET_URL=$(pick_asset_url "$RELEASE_JSON" 'arm64-mac\.zip')
    if [ -z "$ASSET_URL" ]; then
      echo "Error: could not find a macOS ARM64 zip in the latest release." >&2
      exit 1
    fi

    INSTALL_DIR="/Applications"
    ARCHIVE_PATH="$TMP_DIR/Collaborator.zip"
    echo "Downloading $(basename "$ASSET_URL")..."
    curl -fSL --progress-bar "$ASSET_URL" -o "$ARCHIVE_PATH"

    echo "Installing to ${INSTALL_DIR}..."
    ditto -xk "$ARCHIVE_PATH" "$INSTALL_DIR"

    echo "Done. Opening Collaborator..."
    open "$INSTALL_DIR/Collaborator.app"
    ;;
  Linux)
    if [ "$ARCH" != "x86_64" ]; then
      echo "Error: the command-line installer currently supports Linux x64 only." >&2
      exit 1
    fi

    ASSET_URL=$(pick_asset_url "$RELEASE_JSON" '\.AppImage')
    if [ -z "$ASSET_URL" ]; then
      echo "Error: could not find a Linux AppImage in the latest release." >&2
      exit 1
    fi

    INSTALL_DIR="${HOME}/.local/bin"
    INSTALL_PATH="${INSTALL_DIR}/collaborator"
    mkdir -p "$INSTALL_DIR"

    echo "Downloading $(basename "$ASSET_URL")..."
    curl -fSL --progress-bar "$ASSET_URL" -o "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"

    echo "Done. Installed to ${INSTALL_PATH}"
    echo "Run it with: ${INSTALL_PATH}"
    ;;
  *)
    echo "Error: install.sh currently supports macOS and Linux. On Windows, use the installer from the releases page." >&2
    exit 1
    ;;
esac
