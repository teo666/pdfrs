# pdfrs

Motore di manipolazione PDF scritto in Rust, compilato in WebAssembly, pensato per essere consumato da un frontend JS/TS (in prospettiva una SPA Vue, in un repo separato). Ogni operazione è esposta come funzione `async` che ritorna una `Promise`, così il frontend può fare semplicemente `await pdfrs.merge_pdfs(...)`.

Operazioni disponibili: **merge**, **split**, **rotazione pagine**, **composizione** (riordino/interleaving di pagine tra più documenti), **cifratura/decifratura** (AES-256), **preview** (rendering di una pagina in PNG, per mostrare una thumbnail per pagina nel frontend).

Documentazione completa in [`docs/`](docs/):

- [`docs/architecture.md`](docs/architecture.md) — perché `lopdf` e `hayro`, struttura del progetto, scelte tecniche per wasm
- [`docs/api.md`](docs/api.md) — le funzioni esposte, firme ed esempi d'uso da JS/TS
- [`docs/development.md`](docs/development.md) — come buildare, testare (Rust e frontend), e usare la pagina di test in `www/`

## Quick start

```bash
# build "core" (merge/split/rotate/compose/encrypt/decrypt, ~650KB, in pkg/)
wasm-pack build --target web --out-dir pkg --no-default-features --features console_error_panic_hook

# build "full" (tutto, incluse preview/import immagini, ~4.3MB, in pkg-full/)
wasm-pack build --target web --out-dir pkg-full

# tutte e due le build più il pacchetto npm unico (pkg-npm/, "pdfrs.js"), con
# "pdfrs.js/core" e "pdfrs.js/full" come subpath export - vedi docs/development.md
./scripts/build-npm-package.sh

# test Rust nativi (funzioni pure, senza wasm)
cargo test

# pagina di test TypeScript per provare le API a mano nel browser
(cd packages/pdfrs-editor && pnpm install)
cd www
pnpm install
pnpm dev          # http://localhost:5173
pnpm test:e2e     # smoke test end-to-end automatico (Playwright)
pnpm test:model   # test del modello logico PdfDocument/PdfEditor (packages/pdfrs-editor)
pnpm test:editor  # test dell'editor visivo Web Components (tab "Editor", src/webcomponents/)
```

## Struttura del repository

```
src/            # crate Rust: bindings wasm_bindgen (src/lib.rs) + logica pura (src/operations/)
tests/          # test wasm-bindgen-test + fixture PDF condivise
examples/       # gen_fixtures.rs rigenera i PDF di test in tests/fixtures/
pkg/            # build "core" (generato, non versionato - vedi docs/architecture.md)
pkg-full/       # build "full" (generato, non versionato - vedi docs/architecture.md)
packages/pdfrs-editor/  # modello PdfDocument/PdfEditor + client Web Worker, usato da www/ e dall'app Vue (pdfrs-app)
www/            # pagina di test TypeScript puro per le API esposte (vedi docs/development.md)
docs/           # documentazione del progetto
```

## Licenza

Doppia licenza, a scelta: [MIT](LICENSE-MIT) o [Apache 2.0](LICENSE-APACHE).
