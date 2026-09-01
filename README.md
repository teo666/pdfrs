# pdfrs

Motore di manipolazione PDF scritto in Rust, compilato in WebAssembly, pensato per essere consumato da un frontend JS/TS (in prospettiva una SPA Vue, in un repo separato). Ogni operazione è esposta come funzione `async` che ritorna una `Promise`, così il frontend può fare semplicemente `await pdfrs.merge_pdfs(...)`.

Operazioni disponibili: **merge**, **split**, **rotazione pagine**, **composizione** (riordino/interleaving di pagine tra più documenti), **cifratura/decifratura** (AES-256), **preview** (rendering di una pagina in PNG, per mostrare una thumbnail per pagina nel frontend).

Documentazione completa in [`docs/`](docs/):

- [`docs/architecture.md`](docs/architecture.md) — perché `lopdf` e `hayro`, struttura del progetto, scelte tecniche per wasm
- [`docs/api.md`](docs/api.md) — le funzioni esposte, firme ed esempi d'uso da JS/TS
- [`docs/development.md`](docs/development.md) — come buildare, testare (Rust e frontend), e usare la pagina di test in `www/`

## Quick start

```bash
# build il modulo wasm (output in pkg/)
wasm-pack build --target web

# test Rust nativi (funzioni pure, senza wasm)
cargo test

# pagina di test TypeScript per provare le API a mano nel browser
cd www
pnpm install
pnpm dev          # http://localhost:5173
pnpm test:e2e     # smoke test end-to-end automatico (Playwright)
```

## Struttura del repository

```
src/            # crate Rust: bindings wasm_bindgen (src/lib.rs) + logica pura (src/operations/)
tests/          # test wasm-bindgen-test + fixture PDF condivise
examples/       # gen_fixtures.rs rigenera i PDF di test in tests/fixtures/
pkg/            # output di `wasm-pack build` (generato, non versionato)
www/            # pagina di test TypeScript puro per le API esposte (vedi docs/development.md)
docs/           # documentazione del progetto
```

## Licenza

Doppia licenza, a scelta: [MIT](LICENSE-MIT) o [Apache 2.0](LICENSE-APACHE).
