#!/usr/bin/env bash
#
# Build the release archive for the Nextcloud App Store:
#   build/nomadtracks-<version>.tar.gz   (top-level folder "nomadtracks")
#
# Then sign it (needs the app-store certificate key, see README):
#   openssl dgst -sha512 -sign .certificates/nomadtracks.key \
#       build/nomadtracks-<version>.tar.gz | openssl base64
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ID=nomadtracks
VERSION="$(sed -n 's/.*<version>\(.*\)<\/version>.*/\1/p' "$SRC/appinfo/info.xml" | head -1)"
OUT="$SRC/build"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT" "$STAGE/$APP_ID"
# Only what the app needs at runtime; repo and dev files stay out.
COPYFILE_DISABLE=1 tar -C "$SRC" -cf - \
	--exclude='.git' --exclude='.gitignore' --exclude='.DS_Store' \
	--exclude='build' --exclude='tests' --exclude='screenshot.jpg' \
	--exclude='deploy.sh' --exclude='build-release.sh' \
	. | tar -C "$STAGE/$APP_ID" -xf -

ARCHIVE="$OUT/$APP_ID-$VERSION.tar.gz"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$ARCHIVE" "$APP_ID"
echo "built $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo
echo "sign with:"
echo "  openssl dgst -sha512 -sign .certificates/$APP_ID.key '$ARCHIVE' | openssl base64"
