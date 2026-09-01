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

### Preview PDF → PNG (`examples/render_preview.rs`)

Renderizza ogni pagina di un PDF in PNG usando `hayro` (lo stesso motore dietro `operations::preview::render_page_preview`), utile per controllare la fedeltà del rendering senza passare da wasm/browser:

```bash
cargo run --example render_preview [percorso/al/file.pdf]   # default: tests/fixtures/two_pages.pdf
```

## Pagina di test TypeScript (`www/`)

Piccolo progetto Vite + TypeScript puro (nessun framework), con un pannello per ciascuna operazione esposta dal wasm. Consuma il pacchetto locale generato in `pkg/` tramite `"pdfrs": "file:../pkg"` in `www/package.json` — va quindi rigenerato (`wasm-pack build --target web`) ogni volta che cambia l'API Rust.

### Il modulo wasm gira in un Web Worker, non sul thread principale

Le funzioni `async`/`Promise` di per sé **non bastano** a evitare che la UI si blocchi: il lavoro (parsing, merge, rendering) è comunque CPU-bound e, se chiamato direttamente, gira sullo stesso thread che disegna la pagina — la Promise si risolve solo a lavoro finito, ma nel frattempo il browser resta fermo se il PDF è grande.

Per questo `www/src/main.ts` non importa mai `"pdfrs"` direttamente. La catena è:

- `src/pdfrs.worker.ts` — gira **dentro un Web Worker**, importa il pacchetto wasm vero (`"pdfrs"`), chiama `init()` una volta, e risponde ai messaggi `{ id, method, args }` eseguendo la funzione corrispondente.
- `src/pdfrs-worker-client.ts` — lato thread principale, espone le stesse firme (`merge_pdfs`, `split_pdf`, ...) ma ogni chiamata è in realtà un giro di `postMessage` verso il worker, incapsulato in una `Promise` tramite una mappa `id -> {resolve, reject}`. I call site (`main.ts`) non sanno che c'è un worker di mezzo.
- `src/worker-protocol.ts` — le forme dei messaggi (`WorkerRequest`/`WorkerResponse`) condivise tra le due parti, così non possono disallinearsi.

**Prova visibile che funziona**: in cima alla pagina c'è un contatore ("UI thread libero — tick: N") che incrementa a ogni `requestAnimationFrame`. Se il thread principale fosse bloccato da una chiamata wasm, si fermerebbe; nello smoke test (`www/e2e/smoke.mjs`) questo è verificato esplicitamente confrontando il valore del contatore prima e dopo un'operazione.

### Trabocchetto da evitare — `Transferable` e buffer riusati

Per default `postMessage(dato)` fa una **structured clone**: copia il dato (ricorsivamente) e manda la copia all'altro thread. Va benissimo per un `Uint8Array` di poche decine di KB come i nostri PDF di test, ma per un file grande vorresti evitare di duplicarlo in memoria solo per passarlo da un thread all'altro. Per questo `postMessage` accetta un secondo argomento:

```ts
worker.postMessage(messaggio, { transfer: [buffer] });
```

Invece di copiare, il motore **sposta la proprietà** del buffer da un thread all'altro — zero-copy, istantaneo anche per file enormi. `ArrayBuffer`, `MessagePort` e `ImageBitmap` sono `Transferable`.

Il prezzo: il trasferimento non è un prestito, è un trasloco. Una volta trasferito, il buffer **originale lato mittente diventa "detached"** — `byteLength` torna a 0, ogni tentativo di rileggerlo o ritrasferirlo fallisce, e non è recuperabile.

**L'errore che abbiamo effettivamente preso** durante l'implementazione: la prima versione di `pdfrs-worker-client.ts` trasferiva sempre i buffer degli argomenti (`worker.postMessage(request, { transfer: collectTransferables(args) })`). Il pannello Preview riusa però lo stesso `Uint8Array` per più chiamate:

```ts
const bytes = await fileToUint8Array(file);
const count = await page_count(bytes);                         // chiamata 1: usa bytes
for (let page = 1; page <= count; page++) {
  const png = await render_page_preview(bytes, page, 0.4);     // chiamate 2, 3, ...: riusano bytes
}
```

Alla prima chiamata (`page_count`) il buffer veniva spostato nel worker e detachato lato main thread. Alla seconda (`render_page_preview`), `bytes` era ancora un `Uint8Array` "vivo" per TypeScript, ma il suo `.buffer` era già morto:

```
Failed to execute 'postMessage' on 'Worker': An ArrayBuffer is detached and could not be cloned.
```

**La regola pratica, applicata in questo progetto**: trasferisci solo ciò che non ti serve più dopo averlo mandato.

- *Risultati* dal worker verso il thread principale: sicuro trasferirli (`pdfrs.worker.ts`, `self.postMessage(response, { transfer: collectTransferables(result) })`) — ogni risultato è generato una volta sola e usato una volta sola.
- *Richieste* dal thread principale verso il worker: **non** vengono trasferite in questo progetto, solo clonate (`pdfrs-worker-client.ts`, `worker.postMessage(request)` senza `transfer`) — un chiamante potrebbe riusare lo stesso buffer per più operazioni, come fa Preview.

Se in futuro serve ottimizzare per PDF di ingresso molto grandi, la via corretta **non** è tornare al transfer diretto degli argomenti, ma clonare il buffer lato chiamante prima di trasferirlo quando sai che ti servirà ancora (`bytes.slice()` crea una copia indipendente da passare in transfer, lasciando l'originale intatto) — così si guadagna la velocità dello zero-copy senza il rischio del detach a sorpresa.

**Importante**: dopo ogni `wasm-pack build`, rilancia anche `pnpm install` dentro `www/`. A differenza di npm, **pnpm non fa un vero symlink live** per le dipendenze `file:` — ne clona un contenuto in `node_modules/.pnpm/` al momento dell'`install`, e quel contenuto non si aggiorna da solo quando `pkg/` cambia sul disco. Se te ne dimentichi, il frontend continua a chiamare funzioni vecchie/mancanti (es. `wasm.page_count is not a function`) o serializza opzioni in un formato che l'API attuale non si aspetta più, con errori che sembrano bug nel codice Rust ma sono solo un pacchetto stantio.

```bash
cd www
pnpm install
pnpm dev            # http://localhost:5173, pagina interattiva
pnpm run build      # build di produzione (verifica tipi + bundle Vite)
pnpm test:e2e       # smoke test end-to-end automatico
```

### Uso interattivo

Il pannello **Preview** è diverso dagli altri: appena rilasci/selezioni un PDF, renderizza subito una card con l'immagine di ogni pagina (nessun pulsante "Esegui" — è pensato per un feedback immediato). Gli altri pannelli (Merge, Split, Rotate, Compose, Encrypt, Decrypt) hanno invece:

- una **dropzone** che accetta drag & drop di PDF (oltre al click per aprire il file picker);
- campi testo per i parametri (es. range pagine `1-2,3-4`, rotazioni `1:90,2:180`, layout `0:1,1:1,0:2`);
- un pulsante "Esegui" che chiama la funzione wasm corrispondente e scarica il PDF risultante;
- un'area di stato che mostra l'esito o l'errore (utile per verificare che gli errori Rust arrivino come messaggi leggibili, non come crash).

Usa i PDF già presenti in `tests/fixtures/` (`one_page.pdf`, `two_pages.pdf`, `four_pages.pdf`) per provare rapidamente ogni pannello.

### Smoke test end-to-end (`www/e2e/smoke.mjs`)

`pnpm test:e2e` avvia da solo un server Vite su una porta dedicata, pilota un vero Chromium headless via Playwright ed esercita tutti i pannelli attraverso la UI reale (non chiamando le funzioni wasm direttamente): il contatore heartbeat (verifica che non si fermi durante un'operazione), preview (conta le card generate), merge, split, rotate, compose, encrypt, e decrypt sia con password corretta che sbagliata. È l'unico test che valida realmente il confine JS↔worker↔wasm (init del modulo nel worker, `postMessage`, serializzazione `JsValue`, download dei risultati) in questo ambiente, dato che `wasm-pack test --headless` non è eseguibile senza `geckodriver`/`chromedriver`.

Se aggiungi un pannello o un'operazione, aggiungi anche il relativo scenario in `smoke.mjs` — non lasciarlo solo come verifica manuale.

### Nota su Vite e `pkg/`

`www/vite.config.ts` imposta `server.fs.allow: [".."]`: senza questa opzione Vite risponde `403` quando la pagina prova a caricare `../pkg/pdfrs_bg.wasm`, perché quel file sta fuori dalla root del progetto `www/`.

## Package manager

Il progetto usa **pnpm** per `www/` (non npm/yarn): `pnpm install`, `pnpm add -D <pacchetto>@latest` per aggiornare le dipendenze. Il lockfile è `www/pnpm-lock.yaml`.
