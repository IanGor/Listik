#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
archive="listik-desktop-$version.tar.gz"
# A deterministic local source archive; excludes dependencies, outputs and the
# recipe itself so recording its checksum does not change the archive.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --transform="s,^,listik-desktop-$version/," \
  --exclude=node_modules --exclude=dist --exclude=tests --exclude=PKGBUILD \
  --exclude='*.tar.gz' --exclude='*.pkg.tar.*' --exclude=src --exclude=pkg \
  -czf "packaging/$archive" package.json package-lock.json main.cjs preload.cjs \
  omarchy.cjs policy.cjs error.html error.js icon.png pack.cjs packaging
checksum=$(sha256sum "packaging/$archive" | cut -d' ' -f1)
sed -i "s/^sha256sums=.*/sha256sums=('$checksum')/" packaging/PKGBUILD
printf 'Source archive: %s\n' "packaging/$archive"
