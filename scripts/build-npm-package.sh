#!/usr/bin/env bash
# Assembles a single npm-publishable package (pkg-npm/, published as
# "pdfrs.js") with two subpath exports, "pdfrs.js/core" and "pdfrs.js/full",
# from the two wasm-pack builds. The .wasm binaries are exported too, so a
# consumer can resolve them from the same package as the JS glue (see
# packages/pdfrs-editor/src/worker/create-pdfrs-worker.ts).
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

# README and licences: npm shows the README on the package page. The
# licences go in "files" below, as npm only picks up a bare LICENSE on its own.
cp scripts/npm-package/README.md LICENSE-MIT LICENSE-APACHE pkg-npm/

cat > pkg-npm/package.json <<EOF
{
  "name": "pdfrs.js",
  "type": "module",
  "version": "$PKG_VERSION",
  "description": "PDF manipulation in the browser (Rust/WebAssembly): merge, split, rotate, compose, N-up, booklet, AES-256 encryption, metadata, bookmarks, images and page previews.",
  "license": "MIT OR Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/teo666/pdfrs.git"
  },
  "homepage": "https://github.com/teo666/pdfrs#readme",
  "bugs": "https://github.com/teo666/pdfrs/issues",
  "keywords": [
    "pdf",
    "wasm",
    "webassembly",
    "merge",
    "split",
    "encrypt",
    "browser"
  ],
  "collaborators": [
    "Teo Basili <basili.teo@gmail.com>"
  ],
  "files": [
    "core",
    "full",
    "LICENSE-MIT",
    "LICENSE-APACHE"
  ],
  "exports": {
    "./core": {
      "types": "./core/pdfrs.d.ts",
      "default": "./core/pdfrs.js"
    },
    "./full": {
      "types": "./full/pdfrs.d.ts",
      "default": "./full/pdfrs.js"
    },
    "./core/pdfrs_bg.wasm": "./core/pdfrs_bg.wasm",
    "./full/pdfrs_bg.wasm": "./full/pdfrs_bg.wasm"
  },
  "sideEffects": [
    "./core/snippets/*",
    "./full/snippets/*"
  ]
}
EOF

echo "pkg-npm/ pronto. Pubblica con: cd pkg-npm && npm publish"
