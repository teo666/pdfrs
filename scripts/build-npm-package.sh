#!/usr/bin/env bash
# Assembles a single npm-publishable package (pkg-npm/) with two subpath
# exports, "pdfrs/core" and "pdfrs/full", from the two wasm-pack builds.
# See docs/development.md ("Build 'core' e 'full'") for why the split exists.
set -euo pipefail
cd "$(dirname "$0")/.."

PKG_VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)

wasm-pack build --target web --out-dir pkg --no-default-features --features console_error_panic_hook
wasm-pack build --target web --out-dir pkg-full

rm -rf pkg-npm
mkdir -p pkg-npm/core pkg-npm/full

for variant in core full; do
  src=pkg
  [ "$variant" = "full" ] && src=pkg-full
  cp "$src"/pdfrs.js "$src"/pdfrs.d.ts "$src"/pdfrs_bg.wasm "$src"/pdfrs_bg.wasm.d.ts "pkg-npm/$variant/"
done

cat > pkg-npm/package.json <<EOF
{
  "name": "pdfrs",
  "type": "module",
  "version": "$PKG_VERSION",
  "collaborators": [
    "Teo Basili <basili.teo@gmail.com>"
  ],
  "files": [
    "core",
    "full"
  ],
  "exports": {
    "./core": "./core/pdfrs.js",
    "./full": "./full/pdfrs.js"
  },
  "sideEffects": [
    "./core/snippets/*",
    "./full/snippets/*"
  ]
}
EOF

echo "pkg-npm/ pronto. Pubblica con: cd pkg-npm && npm publish"
