#!/bin/sh
# Installs the Linux Forge base (a 64-bit kernel + static BusyBox) into
# vendor/linux-base/. Works on Debian/Ubuntu hosts; elsewhere, copy any
# x86_64 bzImage to vendor/linux-base/vmlinuz and a static x86_64 busybox
# to vendor/linux-base/busybox.
set -e
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor/linux-base"
mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
KPKG="$(apt-cache depends linux-image-generic | awk '/Depends: linux-image-[0-9]/ {print $2; exit}')"
[ -n "$KPKG" ] || { echo "could not find a linux-image package"; exit 1; }
echo "downloading $KPKG and busybox-static"
apt-get download "$KPKG" busybox-static
for deb in *.deb; do dpkg-deb -x "$deb" root; done
cp root/boot/vmlinuz-* "$DEST/vmlinuz"
cp root/usr/bin/busybox "$DEST/busybox" 2>/dev/null || cp root/bin/busybox "$DEST/busybox"
chmod 644 "$DEST/vmlinuz"
chmod 755 "$DEST/busybox"
echo "Linux Forge base ready in $DEST"
ls -la "$DEST"
