# Sviluppo e test

## Crate Rust

```bash
# test nativi sulle funzioni pure in src/operations/ (veloci, nessuna build wasm)
cargo test

# verifica che compili per il target wasm
cargo check --target wasm32-unknown-unknown

# build del pacchetto npm in pkg/ (usato da www/, o da un frontend esterno)
wasm-pack build --target web
```

`wasm-pack test --headless --firefox` (o `--chrome`) eseguirebbe i test in `tests/web.rs` in un vero browser, ma richiede `geckodriver`/`chromedriver` installati — non presenti in tutti gli ambienti di sviluppo. Se disponibili, è il modo per validare i binding `#[wasm_bindgen]` end-to-end lato Rust; altrimenti la pagina di test in `www/` (sotto) copre lo stesso confine JS↔wasm.

### Fixture PDF

I PDF usati nei test (`tests/fixtures/*.pdf`) sono generati da un example dedicato:

```bash
cargo run --example gen_fixtures
```

Rilancialo se cambi la struttura dei PDF di prova (es. servono più pagine, font diversi, ecc.).

## Pagina di test TypeScript (`www/`)

Piccolo progetto Vite + TypeScript puro (nessun framework), con un pannello per ciascuna delle 6 operazioni esposte dal wasm. Consuma il pacchetto locale generato in `pkg/` tramite `"pdfrs": "file:../pkg"` in `www/package.json` — va quindi rigenerato (`wasm-pack build --target web`) ogni volta che cambia l'API Rust.

```bash
cd www
pnpm install
pnpm dev            # http://localhost:5173, pagina interattiva
pnpm run build      # build di produzione (verifica tipi + bundle Vite)
pnpm test:e2e       # smoke test end-to-end automatico
```

### Uso interattivo

Ogni pannello (Merge, Split, Rotate, Compose, Encrypt, Decrypt) ha:

- una **dropzone** che accetta drag & drop di PDF (oltre al click per aprire il file picker);
- campi testo per i parametri (es. range pagine `1-2,3-4`, rotazioni `1:90,2:180`, layout `0:1,1:1,0:2`);
- un pulsante "Esegui" che chiama la funzione wasm corrispondente e scarica il PDF risultante;
- un'area di stato che mostra l'esito o l'errore (utile per verificare che gli errori Rust arrivino come messaggi leggibili, non come crash).

Usa i PDF già presenti in `tests/fixtures/` (`one_page.pdf`, `two_pages.pdf`, `four_pages.pdf`) per provare rapidamente ogni pannello.

### Smoke test end-to-end (`www/e2e/smoke.mjs`)

`pnpm test:e2e` avvia da solo un server Vite su una porta dedicata, pilota un vero Chromium headless via Playwright ed esercita tutti e 6 i pannelli attraverso la UI reale (non chiamando le funzioni wasm direttamente): merge, split, rotate, compose, encrypt, e decrypt sia con password corretta che sbagliata. È l'unico test che valida realmente il confine JS↔wasm (init del modulo, serializzazione `JsValue`, download dei risultati) in questo ambiente, dato che `wasm-pack test --headless` non è eseguibile senza `geckodriver`/`chromedriver`.

Se aggiungi un pannello o un'operazione, aggiungi anche il relativo scenario in `smoke.mjs` — non lasciarlo solo come verifica manuale.

### Nota su Vite e `pkg/`

`www/vite.config.ts` imposta `server.fs.allow: [".."]`: senza questa opzione Vite risponde `403` quando la pagina prova a caricare `../pkg/pdfrs_bg.wasm`, perché quel file sta fuori dalla root del progetto `www/`.

## Package manager

Il progetto usa **pnpm** per `www/` (non npm/yarn): `pnpm install`, `pnpm add -D <pacchetto>@latest` per aggiornare le dipendenze. Il lockfile è `www/pnpm-lock.yaml`.
