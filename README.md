# pdfrs

Motore di manipolazione PDF scritto in Rust, compilato in WebAssembly, pensato per essere consumato da un frontend JS/TS (in prospettiva una SPA Vue, in un repo separato). Ogni operazione è esposta come funzione `async` che ritorna una `Promise`, così il frontend può fare semplicemente `await pdfrs.merge_pdfs(...)`.

Operazioni disponibili: **merge**, **split**, **rotazione pagine**, **composizione** (riordino/interleaving di pagine tra più documenti), **cifratura/decifratura** (AES-256), **preview** (rendering di una pagina in PNG, per mostrare una thumbnail per pagina nel frontend).

## Libreria TypeScript

Il pacchetto browser pubblicabile vive in `packages/pdfrs/` ed espone `PdfDocument`, `PdfEditor`, i tipi pubblici e le operazioni PDF in camelCase. La demo in `www/` è un consumatore separato e non viene inclusa nel pacchetto npm.

```bash
cd packages/pdfrs
pnpm run build
pnpm run test:package
```

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

# test Rust nativi (funzioni pure, senza wasm)
cargo test

# pagina di test TypeScript per provare le API a mano nel browser
cd www
pnpm run demo     # build core + full, pnpm install, avvio su http://localhost:5173

# oppure, se le build WASM e le dipendenze sono già aggiornate
pnpm dev
pnpm test:e2e     # smoke test end-to-end automatico (Playwright)
pnpm test:model   # test del modello logico PdfDocument/PdfEditor (src/pdf-model/)
pnpm test:editor  # test dell'editor visivo Web Components (tab "Editor", src/webcomponents/)
```

## Struttura del repository

```
src/            # crate Rust: bindings wasm_bindgen (src/lib.rs) + logica pura (src/operations/)
tests/          # test wasm-bindgen-test + fixture PDF condivise
examples/       # gen_fixtures.rs rigenera i PDF di test in tests/fixtures/
pkg/            # build "core" (generato, non versionato - vedi docs/architecture.md)
pkg-full/       # build "full" (generato, non versionato - vedi docs/architecture.md)
packages/pdfrs/ # libreria TypeScript pubblicabile su npm
www/            # pagina di test TypeScript puro per le API esposte (vedi docs/development.md)
docs/           # documentazione del progetto
```

## Licenza

Doppia licenza, a scelta: [MIT](LICENSE-MIT) o [Apache 2.0](LICENSE-APACHE).
