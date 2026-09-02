# Architettura

## Panoramica

`pdfrs` è una crate Rust compilata in WebAssembly (`wasm32-unknown-unknown`, target `web` di `wasm-bindgen`/`wasm-pack`) che espone operazioni di manipolazione PDF come funzioni `async` chiamabili da JavaScript/TypeScript, incluso il rendering di una pagina in PNG per le preview (vedi sezione `hayro` sotto).

## Libreria PDF: `lopdf`

Scelto **`lopdf`** per manipolare i documenti:

- **Pure Rust**, zero dipendenze C/di sistema → compila pulito su `wasm32-unknown-unknown`, a differenza di `pdfium-render`/`mupdf-rs` (richiedono binari C/Emscripten) o dei rasterizzatori pure-Rust (orientati al rendering, non alla manipolazione strutturale).
- Copre esattamente le operazioni richieste: `delete_pages`/`page_iter`/`get_pages` per split e riordino, editing diretto della entry `/Rotate` nel dizionario pagina per la rotazione, combinazione di più `Document` per il merge, `encrypt()`/`decrypt()`/`EncryptionState` (AES-256) per cifratura/decifratura.

In `Cargo.toml` la dipendenza è dichiarata con `default-features = false` e feature `wasm_js`:

```toml
lopdf = { version = "0.44", default-features = false, features = ["wasm_js"] }
```

- `default-features = false` disattiva `rayon` (thread pool nativo, non disponibile su `wasm32-unknown-unknown` senza plumbing aggiuntivo) e `chrono-clock` (legge il fuso orario di sistema, non significativo in una sandbox wasm).
- `wasm_js` seleziona il backend `wasm_js` di `getrandom`, necessario dalla 0.36 di `lopdf` in poi per compilare su `wasm32-unknown-unknown` (usato per la generazione di chiavi in fase di cifratura).

## Rendering delle preview: `hayro`

Per la preview delle pagine (una card/immagine per pagina nel frontend) si usa **`hayro`**, un interprete/rasterizzatore PDF pure Rust ([laurenzv/hayro](https://github.com/laurenzv/hayro)):

- **Pure Rust**, nessun binario esterno da costruire con Emscripten (a differenza di `pdfium-render`, che richiederebbe un secondo modulo wasm `pdfium.wasm` separato, con gestione memoria indipendente — complessità valutata e scartata). `hayro` compila con lo stesso `wasm-pack build` del resto della crate.
- In `Cargo.toml`: `hayro = { version = "0.7", default-features = false, features = ["embed-fonts"] }`. `embed-fonts` incorpora i font standard (necessari per renderizzare testo con font non incorporati nel PDF, es. Courier/Helvetica); `embed-cmaps` (supporto CJK) e `simd` (no-op su wasm32) sono disattivati per contenere la dimensione del bundle.
- **Compromesso principale: dimensione del bundle.** Aggiungere `hayro` porta il `.wasm` da ~650 KB a **~4.3 MB** — è il costo di un motore di rendering PDF completo in Rust puro (font shaping, color management, decoder immagine), non riducibile granché via feature flag (la maggior parte della dimensione viene da `vello_cpu`/`skrifa`/`moxcms`, non dai font embedded).
- **Limiti noti**: progetto dichiaratamente "sperimentale"; non gestisce direttamente PDF cifrati (per questo `render_page_preview` si aspetta byte già decriptati, coerente col resto della pipeline che decripta separatamente con `operations::crypto::load_decrypted`).
- Verificato concretamente in Chromium reale (non solo `cargo check`): stesso output PNG del rendering nativo, nessun errore console.

## Import di immagini raster: `image_to_pdf`

`operations::image::image_to_pdf` converte un **JPEG** in un PDF di una pagina, in modo che possa essere combinato con PDF veri usando `merge_pdfs`/`compose_pdf` esistenti, senza nessuna logica di combinazione nuova — una volta convertita, è un PDF come un altro per il resto della pipeline.

- **Nessuna ridecodifica dei pixel**: i byte JPEG vengono incorporati così come sono in uno `Stream` con `/Filter /DCTDecode` — si legge solo l'header (via il crate `image`, feature `jpeg` soltanto: `zune-jpeg`/`jpeg-encoder`, entrambi pure Rust) per ricavare dimensioni e spazio colore (`DeviceRGB`/`DeviceGray`; i JPEG CMYK vengono rifiutati esplicitamente, rari e con una insidia nota di inversione dati). Costo praticamente nullo in dimensione del bundle: `zune-jpeg` è già una dipendenza transitiva di `hayro`.
- **Dimensioni pagina**: `PageSize::Native` (default) — la pagina è grande esattamente quanto l'immagine (1px = 1pt); `A4`/`Letter` — l'immagine viene centrata e scalata per stare dentro la pagina (`fitted_size`, un semplice "contain": nessun ritaglio, nessuna distorsione dell'aspect ratio). `Orientation::Auto` (default per A4/Letter) sceglie ritratto/paesaggio in base all'aspect ratio dell'immagine.
- **Punto delicato — compressione doppia**: `merge_pdfs`/`compose_pdf`/`split_pdf` chiamano tutti `Document::compress()` alla fine. Uno stream già codificato `DCTDecode` **non va ricompresso con Flate sopra** — corromperebbe l'immagine. Lo stream dell'immagine viene creato con `allows_compression = false` (stesso accorgimento che lopdf raccomanda per gli stream dei font). Verificato concretamente: un test unisce un PDF-da-immagine con un PDF vero via `merge_pdfs` (che chiama `compress()`) e poi *renderizza* la pagina risultante con `render_page_preview` — se la compressione avesse corrotto il JPEG, `hayro` fallirebbe a decodificarlo, non solo a produrre un file strutturalmente valido.

## Build "core" e "full": feature `preview`/`image-import`

`hayro` e `image` sono dipendenze **opzionali** (`optional = true` in `Cargo.toml`), dietro due feature dedicate:

```toml
[features]
default = ["console_error_panic_hook", "preview", "image-import"]
preview = ["dep:hayro"]
image-import = ["dep:image"]
```

Entrambe sono nel `default`, quindi un `cargo build`/`wasm-pack build` senza flag produce lo stesso binario "pieno" di sempre — questo split esiste per permettere a chi consuma la crate di **scegliere** di ometterle, non per cambiare il comportamento di default. In `src/operations/mod.rs` i moduli `preview`/`image` sono dietro lo stesso `#[cfg(feature = ...)]`; in `src/lib.rs`, le funzioni `#[wasm_bindgen]` `render_page_preview`/`image_to_pdf` altrettanto.

Questo abilita due build wasm distinte, entrambe verificate concretamente (dimensioni misurate, non stimate):

- **`pkg/` (core)**: `wasm-pack build --target web --out-dir pkg --no-default-features --features console_error_panic_hook` — solo `merge_pdfs`/`split_pdf`/`rotate_pages`/`compose_pdf`/`encrypt_pdf`/`decrypt_pdf`/`page_count`. **~650 KB** (torna alla dimensione pre-`hayro`).
- **`pkg-full/` (full)**: `wasm-pack build --target web --out-dir pkg-full` (default features) — tutto, incluso `render_page_preview`/`image_to_pdf`. **~4.3 MB**.

Il frontend (`www/`) consuma entrambe: `pdfrs` (→ `pkg/`, core) è importato staticamente per le sei operazioni sempre disponibili; `pdfrs-full` (→ `pkg-full/`) è importato **dinamicamente**, solo la prima volta che `render_page_preview`/`image_to_pdf` sono davvero richiesti — vedi la sezione sul worker in `docs/development.md` per il dettaglio del lazy loading e la verifica via tracciamento delle richieste di rete.

## Struttura della crate

```
src/
  lib.rs             # bindings #[wasm_bindgen] pubblici: decodifica input JS, chiama la logica pura, ri-serializza l'output
  error.rs            # PdfrsError (thiserror) + From<PdfrsError> for JsValue
  utils.rs            # panic hook per messaggi di errore leggibili in console
  operations/
    merge.rs           # merge_pdfs
    split.rs           # split_pdf (per range di pagine)
    rotate.rs          # rotate_pages
    compose.rs         # riordino/interleaving di pagine tra documenti diversi
    crypto.rs          # encrypt_pdf / decrypt_pdf
    preview.rs         # render_page_preview (rendering pagina -> PNG, via hayro)
    image.rs           # image_to_pdf (JPEG -> PDF di una pagina)
```

Ogni modulo in `operations/` contiene funzioni Rust pure (`fn merge(docs: Vec<Document>) -> Result<Document, PdfrsError>`, ecc.), testabili con `cargo test` senza bisogno di una build wasm. `src/lib.rs` fa da adattatore verso JS: decodifica `Uint8Array`/`JsValue`, chiama la funzione pura corrispondente, e ri-serializza il risultato.

## Perché `async fn` anche per operazioni sincrone

Le operazioni sono CPU-bound (nessuna I/O reale), ma ogni binding pubblico è dichiarato `async fn` sotto `#[wasm_bindgen]`: wasm-bindgen genera automaticamente il wrapper JS che ritorna una `Promise`, così il frontend può scrivere `await pdfrs.merge_pdfs(...)` in modo idiomatico invece di gestire callback o valori sincroni. Gli errori (`PdfrsError`) si convertono in `JsValue`/`js_sys::Error`, quindi diventano rigetti di Promise (`try/catch` lato JS) invece di panic non gestiti.

## Nota tecnica: decifratura e password

`Document::load_mem` (senza password) su un PDF protetto da password non vuota **non fallisce con un errore**, ma restituisce un documento con `objects` vuoto: lopdf abbandona il parsing degli oggetti se l'autenticazione a password vuota fallisce e nessuna password è stata fornita al caricamento. Chiamare poi `.decrypt(password)` su quel documento "succede" senza errori ma non decripta nulla, perché non c'è nulla da decriptare.

Per questo `operations::crypto::load_decrypted` carica direttamente con la password:

```rust
Document::load_mem_with_options(bytes, LoadOptions::with_password(password))
```

A questo punto il documento è già decriptato (l'entry `/Encrypt` viene rimossa durante il caricamento stesso); non serve né è possibile chiamare `.decrypt()` in un secondo momento. Una password sbagliata fa fallire direttamente `load_mem_with_options` con un errore, che risale fino al frontend come Promise rigettata.

## wasm-pack e il pacchetto npm

`wasm-pack build --target web` genera `pkg/` (non versionato, in `.gitignore`) con `pdfrs.js`, `pdfrs_bg.wasm` e i tipi TypeScript (`pdfrs.d.ts`), pronti per essere importati come modulo ES: `import init, { merge_pdfs, ... } from "pdfrs"; await init();`. Il frontend di test in `www/` consuma questo pacchetto localmente via `"pdfrs": "file:../pkg"` (vedi [`development.md`](development.md)).
