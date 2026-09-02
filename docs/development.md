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

### Preview su documenti grandi: pool di worker con coda dinamica

Un solo worker rende le pagine una alla volta — non blocca la UI, ma per un documento con molte pagine il rendering totale resta comunque lento in wall-clock, perché una sola pagina alla volta gira su un solo core. `src/preview-worker-pool.ts` risolve questo caso specifico: sopra `PARALLEL_PREVIEW_THRESHOLD` pagine (6, in `main.ts`), il pannello Preview crea un piccolo pool di worker (`Math.min(navigator.hardwareConcurrency, pageCount, 8)`, ognuno con la propria copia del modulo wasm) e distribuisce le pagine da una **coda condivisa**: ogni worker libero prende la pagina successiva, invece di ricevere in anticipo un blocco fisso di pagine. Questo evita che un worker resti bloccato su un blocco di pagine pesanti mentre un altro, con pagine leggere, ha già finito ed è inattivo — il bilanciamento del carico è automatico.

Conseguenze pratiche di questo design:

- **`onPage` completa fuori ordine**: le pagine finiscono nell'ordine in cui i worker le processano, non nell'ordine 1, 2, 3... Per questo il pannello Preview crea prima una card segnaposto per ogni pagina (`cardImages: Map<number, HTMLImageElement>` in `main.ts`) e riempie l'immagine giusta quando arriva, invece di fare `appendChild` man mano — se aggiungi un altro consumatore di `renderPagesInParallel`, tienilo a mente.
- **Costo per worker aggiuntivo**: ogni worker del pool istanzia una copia indipendente del modulo wasm (~4.3 MB, per via di `hayro`). Per pochi worker e documenti grandi ne vale la pena; per documenti piccoli l'overhead di avvio supererebbe il guadagno — da qui la soglia `PARALLEL_PREVIEW_THRESHOLD`, sotto la quale si usa il singolo worker condiviso già esistente (`pdfrs-worker-client.ts`).
- **Ciclo di vita**: i worker del pool sono creati per la singola chiamata a `renderPagesInParallel` e terminati (`worker.terminate()`) alla fine, con o senza errore — non sono un pool persistente riusato tra una preview e l'altra.
- **Verifica nello smoke test**: `tests/fixtures/ten_pages.pdf` (10 pagine, sopra soglia) esercita il pool; `preview-worker-pool.ts` espone `window.__pdfrsLastPreviewPoolSize` proprio per permettere allo smoke test di verificare concretamente che siano stati usati più worker (`previewPoolSize > 1`), invece di dedurlo indirettamente dai tempi.

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

I 7 pannelli (Preview, Merge, Split, Rotate, Compose, Encrypt, Decrypt) stanno tutti sulla stessa pagina, con una sidebar a sinistra che ne mostra uno alla volta — il cambio è puro JS (`panel.hidden = true/false` in `main.ts`), **nessun cambio di URL/route**. L'indicatore heartbeat resta sempre visibile in cima, indipendentemente dal pannello attivo.

Il pannello **Preview** è diverso dagli altri: appena rilasci/selezioni un PDF, renderizza subito una card con l'immagine di ogni pagina (nessun pulsante "Esegui" — è pensato per un feedback immediato). Gli altri pannelli (Merge, Split, Rotate, Compose, Encrypt, Decrypt) hanno invece:

- una **dropzone** che accetta drag & drop di PDF (oltre al click per aprire il file picker);
- campi testo per i parametri (es. range pagine `1-2,3-4`, rotazioni `1:90,2:180`, layout `0:1,1:1,0:2`);
- un pulsante "Esegui" che chiama la funzione wasm corrispondente e scarica il PDF risultante;
- un'area di stato che mostra l'esito o l'errore (utile per verificare che gli errori Rust arrivino come messaggi leggibili, non come crash).

Usa i PDF già presenti in `tests/fixtures/` (`one_page.pdf`, `two_pages.pdf`, `four_pages.pdf`, `ten_pages.pdf`) per provare rapidamente ogni pannello — `ten_pages.pdf` supera `PARALLEL_PREVIEW_THRESHOLD` ed è utile per vedere il pool di worker in azione nel pannello Preview.

### Smoke test end-to-end (`www/e2e/smoke.mjs`)

`pnpm test:e2e` avvia da solo un server Vite su una porta dedicata, pilota un vero Chromium headless via Playwright ed esercita tutti i pannelli attraverso la UI reale (non chiamando le funzioni wasm direttamente): il contatore heartbeat (verifica che non si fermi durante un'operazione), preview (conta le card generate), merge, split, rotate, compose, encrypt, e decrypt sia con password corretta che sbagliata. È l'unico test che valida realmente il confine JS↔worker↔wasm (init del modulo nel worker, `postMessage`, serializzazione `JsValue`, download dei risultati) in questo ambiente, dato che `wasm-pack test --headless` non è eseguibile senza `geckodriver`/`chromedriver`.

Se aggiungi un pannello o un'operazione, aggiungi anche il relativo scenario in `smoke.mjs` — non lasciarlo solo come verifica manuale. Dato che i pannelli inattivi sono `hidden`, ricordati di passare alla tab giusta prima di interagirci (`switchTab("panel-<nome>")` in cima allo scenario) — `page.click`/`page.fill` falliscono su un elemento nascosto (Playwright richiede visibilità), mentre `page.setInputFiles` funziona comunque anche se il pannello non è attivo.

### Modello logico del PDF: `PdfDocument` / `PdfEditor` (`src/pdf-model/`)

Sopra le funzioni stateless viste finora c'è un livello di modello puro (nessun DOM, nessun riferimento a `window`/`document`), pensato per essere riusato da un front qualsiasi — anche il futuro front Vue in repo separata:

- **`PdfDocument`** (`src/pdf-model/PdfDocument.ts`) — modella *un* PDF caricato e le modifiche pagina-per-pagina non ancora confermate. `PdfDocument.open(bytes)` (async, unico modo di costruirne uno) chiama solo `page_count` — **mai** una preview in automatico. `rotatePage(id, degrees)`/`deletePage(id)`/`restorePage(id)`/`resetRotation(id)` aggiornano solo lo stato in memoria (una `Map`/`Set` di modifiche pendenti), nessuna chiamata wasm. `getPreview(id)`/`getPreviews()` renderizzano su richiesta esplicita (quest'ultimo usa internamente `renderPagesInParallel` sopra soglia, la stessa logica prima duplicata nel pannello Preview di `main.ts`). `commit()` applica le modifiche pendenti (muta l'istanza, azzera lo stato pendente); `exportBytes()` fa lo stesso calcolo senza mutare, per un'anteprima del risultato finale prima di confermare.
- **`PdfEditor`** (`src/pdf-model/PdfEditor.ts`) — registro di più `PdfDocument`, con le operazioni che intrinsecamente coinvolgono più documenti (`mergeDocuments`, `splitDocument`), che non avrebbe senso modellare dentro un singolo documento.

**Il punto delicato di `commit()`**: le rotazioni pendenti sono tracciate per `id` di pagina originale, ma se nel frattempo altre pagine sono state eliminate, la posizione finale di una pagina superstite cambia. `commit()`/`exportBytes()` rimappano quindi ogni rotazione pendente dalla vecchia `id` alla **nuova posizione** (l'indice della pagina superstite dopo `compose_pdf`), prima di chiamare `rotate_pages`. Se elimini pagina 2 e vuoi ruotare l'originale pagina 3 di un documento di 4 pagine, dopo il commit la rotazione deve finire sulla pagina in posizione 2 (non 3) del documento risultante da 3 pagine.

**Cache delle preview**: `getPreview`/`getPreviews` tengono una `Map<string, Uint8Array>` interna, chiave `${id}:${scale}`. Le renderizzazioni sono cachate perché dipendono solo dai byte della baseline corrente, **mai** dalle modifiche pendenti — `getPreview` renderizza sempre la pagina così com'è nella baseline (vedi sopra), quindi `rotatePage`/`deletePage`/`restorePage`/`resetRotation` non devono invalidare nulla: la stessa card resta valida, cambiano solo i metadati (`pendingRotation`/`markedForDeletion`) che vengono ricalcolati al volo a ogni chiamata, indipendentemente dalla cache. Solo un cambio della baseline stessa la invalida (`this.previewCache.clear()` in `commit()`, `encrypt()`, `decrypt()`). `getPreviews()` riusa quello che è già in cache e chiede al worker/pool solo le pagine effettivamente mancanti (`renderPagesInParallel` accetta un elenco di numeri di pagina arbitrario, non necessariamente contiguo, proprio per questo).

**`getPreviews(scale, options)`** accetta anche due opzioni, entrambe pensate per i documenti grandi:

- **`onProgress?: (done: number, total: number) => void`** — chiamato dopo ogni pagina completata (anche le cache hit contano come "fatte" all'istante, così una barra di avanzamento riflette davvero quante pagine sono pronte, non solo quelle effettivamente renderizzate). Con più worker le pagine completano fuori ordine, quindi `done` avanza a scatti non uniformi — non un progresso lineare nel tempo, ma comunque un conteggio reale, non simulato.
- **`range?: { start, end }`** (1-indicizzato, inclusivo) — renderizza solo una finestra del documento invece di tutte le pagine. Si appoggia alla stessa cache e alla stessa logica "solo le mancanti" di sopra: chiedere due finestre che si sovrappongono non rirenderizza le pagine già viste. Un range che esce dai limiti del documento fa fallire la chiamata esplicitamente invece di essere silenziosamente troncato.

Nell'editor (`pdf-document-view.ts`), il `<progress>` nativo nella toolbar usa `onProgress` per riempirsi in tempo reale durante `refresh()`, e resta nascosto (`hidden`) fuori da un rendering in corso — è la dimostrazione visiva di questa API, verificata nello smoke test dell'editor (sotto) controllando che diventi visibile durante il rendering di un documento e torni nascosta a fine lavoro.

Lo stesso pattern è integrato anche nel pannello **Preview** del banco di prova a basso livello (`main.ts`), che non passa da `PdfDocument` ma chiama `page_count`/`render_page_preview`/`renderPagesInParallel` direttamente: un `<progress id="preview-progress">` si riempie a ogni pagina completata (nel ramo sequenziale come in quello col pool) e lo stato testuale mostra "Rendering anteprime… (n/m)" finché non è finito.

**Trabocchetto incontrato integrandolo**: `smoke.mjs` aveva un helper `waitForSettledStatus` che considerava "impostato" qualsiasi testo diverso da `"In corso…"` — con gli stati intermedi "Rendering anteprime… (n/m)" questo faceva risultare il test "concluso" alla prima pagina renderizzata, non a rendering finito. Corretto controllando esplicitamente che il testo inizi per `"Fatto"` o `"Errore"` (gli unici stati davvero terminali), non un generico "non è più In corso…". Tienilo a mente se aggiungi un altro pannello con stati di stato intermedi.

**Verifica** (`www/e2e/pdf-model.mjs`, `pnpm test:model`): stesso pattern di `smoke.mjs` (avvia Vite da solo, Chromium headless via Playwright), ma pilota le classi direttamente tramite una paginetta di solo test (`www/model-test.html` + `src/model-test-entry.ts`, che espone `window.__pdfModel = { PdfDocument, PdfEditor }`) invece che attraverso `index.html` — queste classi non hanno una UI propria. Copre, tra gli altri, il caso della rimappatura sopra: elimina una pagina, ruota un'altra, fa il commit, e verifica **concretamente** (non solo "non è andato in errore") che la rotazione sia finita sulla pagina giusta confrontando le dimensioni (larghezza/altezza) del PNG renderizzato prima e dopo — se `hayro` rispetta `/Rotate` (lo fa), una pagina ruotata di 90° ha dimensioni invertite rispetto all'originale. Copre anche la cache: la prova che una preview viene **davvero** servita dalla cache (non solo che il contenuto sembra uguale) è l'uguaglianza di **riferimento** dello stesso `Uint8Array` tra due chiamate (`first.png === second.png` dentro `page.evaluate`) — un rendering rifatto da capo produrrebbe sempre un nuovo `Uint8Array`, anche a parità di contenuto.

Non collegato inizialmente a `main.ts`/`index.html` — quel collegamento visivo è la tab **Editor** descritta subito sotto.

### Editor visivo con Web Components (`src/webcomponents/`, tab "Editor")

Sopra `PdfDocument`/`PdfEditor` c'è un esempio con **Web Component nativi** (Custom Elements + Shadow DOM, nessun framework) che li wrappa visivamente — un'anteprima concreta di come un frontend reale (il futuro front Vue) potrebbe farlo, dato che i custom element si usano da qualunque framework, Vue incluso.

- **`<pdf-editor-app>`** (`pdf-editor-app.ts`) — crea e possiede una `PdfEditor`. Dropzone per aprire uno o più PDF, lista dei documenti aperti (con checkbox per selezionarli e unirli via `mergeDocuments`), e il documento attivo mostrato tramite `<pdf-document-view>`.
- **`<pdf-document-view>`** (`pdf-document-view.ts`) — wrappa un singolo `PdfDocument`: renderizza `getPreviews()` come una griglia di `<pdf-page-card>`, gestisce gli eventi `page-action` che risalgono da esse chiamando `rotatePage`/`deletePage`/`restorePage` sul documento, ed espone i pulsanti "Conferma modifiche" (`commit()`), "Scarica anteprima risultato" (`exportBytes()`) e "Scarica documento" (`getBytes()`).
- **`<pdf-page-card>`** (`pdf-page-card.ts`) — una singola card pagina: mostra il PNG, applica la rotazione pendente **via CSS** (`transform: rotate(...)`) invece di richiederla di nuovo al modello — coerente con la scelta di design di `PdfDocument.getPreview()` (vedi sopra: la preview non riflette le modifiche pendenti nel bitmap, solo nei metadati) — e mostra un overlay per le pagine marcate per l'eliminazione. Non tocca mai `PdfDocument` direttamente: dispatcha un evento `page-action` (`bubbles: true, composed: true` per attraversare i confini di ogni shadow root) e lascia che sia `<pdf-document-view>` a decidere cosa fare.

**Punto pratico**: ruotare/eliminare una pagina nell'editor non fa **nessuna** chiamata wasm — sono mutazioni locali su `PdfDocument` (`Map`/`Set` in memoria), quindi la card si aggiorna all'istante. Solo `commit()` (via `compose_pdf`/`rotate_pages`) e l'apertura iniziale (`page_count` + `getPreviews()`) toccano davvero il worker/wasm.

Registrati una sola volta con un side-effect import (`import "./webcomponents"` in `main.ts`) prima che i tag vengano usati nel markup di `index.html` (tab "Editor" → `<pdf-editor-app></pdf-editor-app>`).

**Verifica** (`www/e2e/editor.mjs`, `pnpm test:editor`): stesso pattern delle altre suite, ma attraversa gli shadow root reali (`el.shadowRoot.querySelector(...)`) invece del DOM normale. Copre il flusso completo: apertura di due documenti, rotazione + eliminazione (verificate come stato locale, non come chiamate), commit (il conteggio pagine scende), merge dei due documenti — con la rotazione committata sulla prima pagina ancora visibile nel documento unito finale, prova che sopravvive all'intera pipeline (rotate pendente → commit → merge) — e infine la barra di avanzamento: apre `ten_pages.pdf` e verifica che il `<progress>` diventi visibile durante il rendering e torni nascosto una volta completato.

### Nota su Vite e `pkg/`

`www/vite.config.ts` imposta `server.fs.allow: [".."]`: senza questa opzione Vite risponde `403` quando la pagina prova a caricare `../pkg/pdfrs_bg.wasm`, perché quel file sta fuori dalla root del progetto `www/`.

## Package manager

Il progetto usa **pnpm** per `www/` (non npm/yarn): `pnpm install`, `pnpm add -D <pacchetto>@latest` per aggiornare le dipendenze. Il lockfile è `www/pnpm-lock.yaml`.
