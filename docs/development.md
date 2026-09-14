# Sviluppo e test

## Crate Rust

```bash
# test nativi sulle funzioni pure in src/operations/ (veloci, nessuna build wasm)
cargo test

# verifica che compili per il target wasm
cargo check --target wasm32-unknown-unknown

# build "core" in pkg/ (merge/split/rotate/compose/encrypt/decrypt, ~650KB - usato da www/, o da un frontend esterno)
wasm-pack build --target web --out-dir pkg --no-default-features --features console_error_panic_hook

# build "full" in pkg-full/ (tutto, incluse preview/import immagini, ~4.3MB)
wasm-pack build --target web --out-dir pkg-full
```

Vedi docs/architecture.md ("Build \"core\" e \"full\"") per il perché dello split: entrambe le feature `preview`/`image-import` sono nel `default`, quindi vanno esplicitamente disattivate per ottenere il binario piccolo - un `wasm-pack build --target web` senza flag produce comunque il binario "full" completo.

Per compilare entrambe le varianti, aggiornare i pacchetti locali e avviare subito la demo con Vite basta un solo comando:

```bash
cd www
pnpm run demo
```

Il comando si ferma immediatamente se una build o `pnpm install` fallisce; `pnpm dev` viene eseguito soltanto al termine delle fasi precedenti.

`wasm-pack test --headless --firefox` (o `--chrome`) esegue i test in `tests/web.rs` in un vero browser, ma richiede `geckodriver`/`chromedriver` installati — non presenti in tutti gli ambienti di sviluppo. (Nota: la funzione di start del crate si chiama `start`, non `main`, proprio perché wasm-bindgen rifiuta di linkare l'harness di test quando entrambi esportano un `main` — "the name `main` is exported by multiple crates in this build".) Se disponibili, è il modo per validare i binding `#[wasm_bindgen]` end-to-end lato Rust; altrimenti la pagina di test in `www/` (sotto) copre lo stesso confine JS↔wasm.

### Fixture PDF (e JPEG)

I PDF usati nei test (`tests/fixtures/*.pdf`) — e da poco anche un JPEG di prova, `tests/fixtures/photo.jpg` (un gradiente generato al volo, non una foto vera, ma sufficiente per testare l'import immagini) — sono generati da un example dedicato:

```bash
cargo run --example gen_fixtures
```

Rilancialo se cambi la struttura dei PDF di prova (es. servono più pagine, font diversi, ecc.) o le dimensioni del JPEG di test.

### Preview PDF → PNG (`examples/render_preview.rs`)

Renderizza ogni pagina di un PDF in PNG usando `hayro` (lo stesso motore dietro `operations::preview::render_page_preview`), utile per controllare la fedeltà del rendering senza passare da wasm/browser:

```bash
cargo run --example render_preview [percorso/al/file.pdf]   # default: tests/fixtures/two_pages.pdf
```

## Pagina di test TypeScript (`www/`)

Piccolo progetto Vite + TypeScript puro (nessun framework), con un pannello per ciascuna operazione esposta dal wasm. Consuma **due** pacchetti locali: `"pdfrs": "file:../pkg"` (core) e `"pdfrs-full": "file:../pkg-full"` (full) in `www/package.json` — vanno quindi rigenerati (entrambi i comandi `wasm-pack build` sopra) ogni volta che cambia l'API Rust, seguiti da `pnpm install` (vedi sotto per il perché).

### Il modulo wasm gira in un Web Worker, non sul thread principale

Le funzioni `async`/`Promise` di per sé **non bastano** a evitare che la UI si blocchi: il lavoro (parsing, merge, rendering) è comunque CPU-bound e, se chiamato direttamente, gira sullo stesso thread che disegna la pagina — la Promise si risolve solo a lavoro finito, ma nel frattempo il browser resta fermo se il PDF è grande.

Per questo `www/src/main.ts` non importa mai `"pdfrs"` direttamente. La catena è:

- `src/pdfrs.worker.ts` — gira **dentro un Web Worker**, importa il pacchetto wasm vero (`"pdfrs"`), inizializza il modulo (vedi sotto) e risponde ai messaggi `{ id, method, args }` eseguendo la funzione corrispondente.
- `src/pdfrs-worker-client.ts` — lato thread principale, espone le stesse firme (`merge_pdfs`, `split_pdf`, ...) ma ogni chiamata è in realtà un giro di `postMessage` verso il worker, incapsulato in una `Promise` tramite una mappa `id -> {resolve, reject}`. I call site (`main.ts`) non sanno che c'è un worker di mezzo.
- `src/worker-protocol.ts` — le forme dei messaggi (`WorkerRequest`/`WorkerResponse`/`WorkerInitMessage`) condivise tra le parti, così non possono disallinearsi.
- `src/create-pdfrs-worker.ts` — punto unico di creazione per **ogni** istanza di `pdfrs.worker.ts` nell'app (sia il worker singolo condiviso di `pdfrs-worker-client.ts`, sia ciascuno del pool descritto sotto). Vedi "Modulo wasm compilato una volta" più sotto.

**Prova visibile che funziona**: in cima alla pagina c'è un contatore ("UI thread libero — tick: N") che incrementa a ogni `requestAnimationFrame`. Se il thread principale fosse bloccato da una chiamata wasm, si fermerebbe; nello smoke test (`www/e2e/smoke.mjs`) questo è verificato esplicitamente confrontando il valore del contatore prima e dopo un'operazione.

### Modulo wasm compilato una volta, condiviso tra tutti i worker

Ogni worker (singolo o del pool) userebbe, se lasciato al comportamento di default di wasm-bindgen, il proprio `fetch` + `WebAssembly.compile` del binario — ripetuto per ogni worker creato. `create-pdfrs-worker.ts` centralizza questo: la prima volta che un worker viene creato, compila il binario una sola volta (`WebAssembly.compileStreaming`, con fallback a `fetch` + `WebAssembly.compile` se lo streaming non è disponibile) e tiene il risultato come una `Promise<WebAssembly.Module>` a livello di modulo. Ogni worker successivo riceve lo stesso `WebAssembly.Module` già compilato via `postMessage` (i moduli wasm sono clonabili in structured clone), e deve solo instanziarlo (`init(module)`), non ricompilarlo da zero.

Lato worker (`pdfrs.worker.ts`), l'inizializzazione non parte più eagerly a livello di modulo: il worker aspetta il primo `WorkerInitMessage` (`{type: "wasm-module", module}` nel percorso normale, `{type: "wasm-init-fallback"}` se la compilazione condivisa fallisce per qualche motivo, nel qual caso il worker si auto-inizializza con `init()` come prima) prima di processare qualunque `WorkerRequest`.

### Preview su documenti grandi: pool di worker persistente con coda dinamica

Un solo worker rende le pagine una alla volta — non blocca la UI, ma per un documento con molte pagine il rendering totale resta comunque lento in wall-clock, perché una sola pagina alla volta gira su un solo core. `src/preview-worker-pool.ts` risolve questo caso specifico: sopra `PARALLEL_PREVIEW_THRESHOLD` pagine (6, in `main.ts`), il rendering si distribuisce su un piccolo pool di worker (dimensione tipica `Math.min(navigator.hardwareConcurrency, pageCount, 8)`, tutti creati tramite `createPdfrsWorker()` e quindi tutti a condividere lo stesso modulo wasm già compilato) e le pagine vengono assegnate da una **coda condivisa**: ogni worker libero prende la pagina successiva, invece di ricevere in anticipo un blocco fisso di pagine. Questo evita che un worker resti bloccato su un blocco di pagine pesanti mentre un altro, con pagine leggere, ha già finito ed è inattivo — il bilanciamento del carico è automatico.

Conseguenze pratiche di questo design:

- **`onPage` completa fuori ordine**: le pagine finiscono nell'ordine in cui i worker le processano, non nell'ordine 1, 2, 3... Per questo il pannello Preview crea prima una card segnaposto per ogni pagina (`cardImages: Map<number, HTMLImageElement>` in `main.ts`) e riempie l'immagine giusta quando arriva, invece di fare `appendChild` man mano — se aggiungi un altro consumatore di `renderPagesInParallel`, tienilo a mente.
- **Ciclo di vita — persistente, non ricreato per chiamata**: il pool vive a livello di modulo (array `workers`/`idleWorkers` in `preview-worker-pool.ts`) e cresce solo verso l'alto (`ensurePoolSize`), non viene mai smontato tra una chiamata a `renderPagesInParallel` e la successiva. Una seconda preview su un documento grande non ripaga il costo di avvio worker/wasm se il pool è già caldo dalla prima. La coda (`queue`) è anch'essa condivisa tra chiamate diverse, non ricreata ogni volta.
- **Dispatcher**: `pump()` assegna job in coda a ogni worker che si libera (chiamato sia subito dopo aver accodato nuovi job, sia da dentro il completamento di ogni job, per continuare a svuotare la coda). Un dettaglio facile da sbagliare: accodare i job e poi aspettare la loro `Promise.all` **prima** di chiamare `pump()` produce un deadlock — nulla viene mai assegnato ai worker se `pump()` non viene invocato esplicitamente subito dopo l'accodamento.
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

**Importante**: dopo ogni `wasm-pack build`, rilancia anche `pnpm install` dentro `www/`. A differenza di npm, **pnpm non fa un vero symlink live** per le dipendenze `file:` — ne clona un contenuto in `node_modules/.pnpm/` al momento dell'`install`, e quel contenuto non si aggiorna da solo quando `pkg/` cambia sul disco. Se te ne dimentichi, il frontend continua a chiamare funzioni vecchie/mancanti (es. `wasm.page_count is not a function`) o serializza opzioni in un formato che l'API attuale non si aspetta più. Il frontend risolve sia il wrapper JS sia il relativo `.wasm` dalla stessa copia installata, quindi rimangono compatibili anche quando quella copia è stantia; `pnpm install` resta comunque necessario perché l'app veda l'API appena compilata.

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

Usa i PDF già presenti in `tests/fixtures/` (`one_page.pdf`, `two_pages.pdf`, `four_pages.pdf`, `ten_pages.pdf`, `many_pages.pdf`) per provare rapidamente ogni pannello — `ten_pages.pdf` supera `PARALLEL_PREVIEW_THRESHOLD` ed è utile per vedere il pool di worker in azione nel pannello Preview; `many_pages.pdf` (30 pagine) supera `VIRTUAL_SCROLL_THRESHOLD` ed è utile per vedere lo scroll virtuale in azione nell'editor.

### Smoke test end-to-end (`www/e2e/smoke.mjs`)

`pnpm test:e2e` avvia da solo un server Vite su una porta dedicata, pilota un vero Chromium headless via Playwright ed esercita tutti i pannelli attraverso la UI reale (non chiamando le funzioni wasm direttamente): il contatore heartbeat (verifica che non si fermi durante un'operazione), preview (conta le card generate), merge, split, rotate, compose, encrypt, e decrypt sia con password corretta che sbagliata. È l'unico test che valida realmente il confine JS↔worker↔wasm (init del modulo nel worker, `postMessage`, serializzazione `JsValue`, download dei risultati) in questo ambiente, dato che `wasm-pack test --headless` non è eseguibile senza `geckodriver`/`chromedriver`.

Se aggiungi un pannello o un'operazione, aggiungi anche il relativo scenario in `smoke.mjs` — non lasciarlo solo come verifica manuale. Dato che i pannelli inattivi sono `hidden`, ricordati di passare alla tab giusta prima di interagirci (`switchTab("panel-<nome>")` in cima allo scenario) — `page.click`/`page.fill` falliscono su un elemento nascosto (Playwright richiede visibilità), mentre `page.setInputFiles` funziona comunque anche se il pannello non è attivo.

### Annotazioni: immagini sulle pagine (`src/operations/stamp.rs`, pannello "Annota")

Il modello è a due livelli: un **asset** è un'immagine caricata una volta, un'**annotazione** è una sua comparsa su una pagina. È la separazione che rende gratuito il caso "la stessa firma su ogni pagina": si costruisce un XObject per asset e lo si registra nelle `/Resources` di ogni pagina che lo usa, quindi cinquanta annotazioni della stessa immagine sono **uno** stream, non cinquanta. Le annotazioni vengono inoltre raggruppate per pagina e applicate insieme, perché `change_page_content` decodifica e ricodifica l'intero content stream: farlo una volta per annotazione significherebbe N cicli completi sulla stessa pagina.

Una conseguenza da conoscere: molti PDF (comprese le fixture di questo repo) condividono **un solo** dizionario `/Resources` fra tutte le pagine. Registrare l'immagine per una pagina la rende quindi *visibile* anche alle altre — ma non disegnata, perché a decidere cosa si vede sono gli operatori `Do` nel content stream. Isolare le risorse per pagina significherebbe duplicare font e risorse a ogni annotazione, un costo reale su documenti veri, per un problema che non produce alcuna differenza visibile. (Diverso il caso delle risorse **ereditate**, sotto, dove non intervenire romperebbe la pagina.)

Tre cose non ovvie, tutte scoperte leggendo il sorgente di lopdf o misurando:

**La decodifica del PNG sta nel browser, non in Rust.** La canvas ha già un decoder, e `getImageData` restituisce alpha **non premoltiplicato** — esattamente la forma che vuole una `/SMask` PDF. Facendola lì, `annotate_pdf` non dipende dal crate `image` e resta nella build **core** invece che nella "full" da 4,3MB. (Il pannello scarica comunque la full, perché mostra le anteprime: il vantaggio è per chi usa la libreria headless.) `www/src/image-io.ts` ridimensiona anche l'immagine a `maxSize` (default 1000px sul lato lungo, parametro della funzione): una firma non ha bisogno di più, e un PNG da 4000×3000 sarebbero 48MB di RGBA grezzo da trasferire e comprimere.

**Il trabocchetto delle `/Resources` ereditate.** `Document::insert_image` di lopdf farebbe quasi tutto (registra l'XObject, accoda `q/cm/Do/Q`, gestisce `/Contents` sia stream sia array), ma passa da `get_or_create_resources`, che guarda **solo** se la pagina ha un `/Resources` proprio. Una pagina che le eredita dal nodo `/Pages` — caso legale e frequente — si ritrova un `/Resources` **vuoto** appiccicato sopra: smette di ereditare, e i font del suo contenuto spariscono. La pagina si aprirebbe senza testo. Quindi prima di stampare, se la pagina non ha un `/Resources` proprio, si risolve quello ereditato con `Document::get_page_resources` (che risale `/Parent` con protezione dai cicli) e lo si **clona** sulla pagina — clonare e non referenziare, perché quel dizionario è condiviso con le altre pagine e l'XObject della firma finirebbe anche sulle loro.

**Il renderer applica `/Rotate`, lopdf lo ignora.** Misurato: la stessa pagina rende 595×842 senza rotazione e 842×595 con `/Rotate 90`; in lopdf la stringa `Rotate` non compare proprio. Quindi il riquadro che l'utente trascina vive nello spazio **visualizzato**, mentre la `cm` va scritta in quello della **pagina**: `stamp_matrix` compone due matrici (unità → rettangolo nello spazio visualizzato, poi visualizzato → pagina) e per 90/270 la rotazione entra nella matrice, il che è anche ciò che fa apparire la firma dritta invece che coricata. I test in `render_tests` (dietro la feature `preview`) renderizzano davvero la pagina annotata e controllano **dove finiscono i pixel**, per tutti e quattro i valori di `/Rotate` e per due immagini su due pagine diverse — è l'unico modo di accorgersi di un segno sbagliato o di annotazioni che si scambiano pagina; una verifica solo algebrica passerebbe lo stesso.

**Il contenuto esistente va avvolto in `q`/`Q`.** Un content stream non è tenuto a lasciare lo stato grafico come l'ha trovato, e molti PDF reali finiscono con una trasformazione ancora attiva — `1 0 0 -1 0 H cm`, il ribaltamento che permette a un generatore di lavorare con la y verso il basso, è il caso classico. La `q`/`Q` attorno al *proprio* disegno non basta: ripristina lo stato com'era quando si è iniziato, non l'identità. Senza bracchettare anche il contenuto originale, l'immagine esce specchiata, ruotata o altrove — con quel `cm` esce capovolta di sotto, ed è un bug che non si vede su una pagina di prova pulita. Il test `survives_a_page_that_leaves_a_transform_in_effect` costruisce apposta una pagina con quello stato sbilanciato.

Nota anche sull'immagine di prova: i test di orientamento usano un marcatore **asimmetrico** (banda rossa in alto, banda blu a sinistra), non un quadrato a tinta unita. Un quadrato uniforme dice dove finisce l'immagine ma non come è orientata, quindi lascerebbe passare esattamente questo genere di errore.

**La rotazione dell'annotazione** è semplicemente un fattore in più nella stessa composizione: l'unit square viene portato sull'origine, scalato, ruotato e infine spostato dove va il centro del rettangolo — così ruotare non sposta l'immagine. Il campo `rotation` promette gradi **orari come li vede chi guarda**, ma la matrice `[cos, sin, -sin, cos]` gira in senso *antiorario* nello spazio usato qui (dove la y cresce verso l'alto, come nella pagina finita), quindi l'angolo va negato. Quale sia il verso giusto non è una cosa da dedurre e sperare: `the_image_turns_clockwise_as_the_reader_sees_it` renderizza la pagina e guarda dove finisce la banda rossa del marcatore — e infatti alla prima stesura il segno era invertito, ed è stato il test ad accorgersene.

Lato interfaccia, due conseguenze meno ovvie della rotazione:

- **Il ridimensionamento va riportato nel sistema del box.** Su un riquadro ruotato lo spostamento del puntatore non è più una variazione di larghezza: serve la sua componente lungo l'asse x locale (`dx·cos θ + dy·sin θ`). Senza, trascinando l'angolo di un'immagine inclinata di 45° la si vede crescere di traverso rispetto al mouse.
- **Ai bordi si vincola il centro, non l'angolo.** Un rettangolo ruotato ha un ingombro diverso, e vincolare gli angoli farebbe "saltare" l'immagine dentro la pagina mentre la si ruota vicino a un bordo. Tenendo dentro il solo centro, l'annotazione resta sempre in parte visibile e la rotazione non sposta mai nulla di sorpresa.

Nota sulla compressione: `save()` non chiama `Document::compress()`, quindi i due stream (RGB e maschera) vengono compressi esplicitamente con `Stream::compress()`, altrimenti il PDF porterebbe megabyte di pixel grezzi. Non c'è rischio di doppia compressione: `compress()` è un no-op se `/Filter` è già presente.

**Nel pannello**, un'immagine si porta sulla pagina trascinandola dalla palette, oppure cliccandola (la mette al centro, ed è il percorso raggiungibile da tastiera). Il drag usa il DnD nativo HTML5, sicuro qui perché questo pannello non ha il riordino delle pagine con cui collide nell'editor; come nell'editor, però, l'id dell'elemento trascinato è tenuto in una variabile e **non** letto dal `dataTransfer`, che il browser riempie con la propria rappresentazione dell'immagine trascinata. Lo smoke test non pilota il drag con il mouse — `dragTo` di Playwright sposta il puntatore sul bersaglio *prima* che il drag inizi, così la sorgente diventa l'immagine della pagina, e i mouse event sintetici non generano affatto eventi drag — ma dispatcha `DragEvent` sintetici, che esercitano comunque la logica di drop del pannello.

### Modello logico del PDF: `PdfDocument` / `PdfEditor` (`src/pdf-model/`)

Sopra le funzioni stateless viste finora c'è un livello di modello puro (nessun DOM, nessun riferimento a `window`/`document`), pensato per essere riusato da un front qualsiasi — anche il futuro front Vue in repo separata:

- **`PdfDocument`** (`src/pdf-model/PdfDocument.ts`) — modella *un* PDF caricato e le modifiche pagina-per-pagina non ancora confermate. `PdfDocument.open(bytes)` (async, unico modo di costruirne uno) chiama solo `page_count` — **mai** una preview in automatico. `rotatePage(id, degrees)`/`deletePage(id)`/`restorePage(id)`/`resetRotation(id)` aggiornano solo lo stato in memoria (una `Map`/`Set` di modifiche pendenti), nessuna chiamata wasm. `getPreview(id)`/`getPreviews()` renderizzano su richiesta esplicita (quest'ultimo usa internamente `renderPagesInParallel` sopra soglia, la stessa logica prima duplicata nel pannello Preview di `main.ts`). `commit()` applica le modifiche pendenti (muta l'istanza, azzera lo stato pendente); `exportBytes()` fa lo stesso calcolo senza mutare, per un'anteprima del risultato finale prima di confermare.
- **`PdfEditor`** (`src/pdf-model/PdfEditor.ts`) — registro di più `PdfDocument`, con le operazioni che intrinsecamente coinvolgono più documenti (`mergeDocuments`, `splitDocument`), che non avrebbe senso modellare dentro un singolo documento.

**Import di immagini**: `PdfDocument.fromImage(bytes, options)` è una **seconda factory statica** (non una sottoclasse) — converte un JPEG in PDF via `image_to_pdf` e apre il risultato come `PdfDocument` qualunque. Deliberatamente non una gerarchia di classi: una volta convertita l'immagine, non c'è nessun comportamento diverso da un `PdfDocument` aperto da un PDF vero (stesso rotate/delete/preview/commit) — l'unica cosa che cambia è *come nasce* l'istanza, e quando l'unica differenza è la costruzione, è il lavoro di una factory, non di una sottoclasse (che tra l'altro avrebbe richiesto indebolire il costruttore privato di `PdfDocument`). `PdfEditor.addImage(bytes, options)` è l'equivalente lato editor di `addDocument()`. Il vantaggio pratico: `mergeDocuments()` non sa né deve sapere se un documento viene da un PDF o da un'immagine — è la stessa identica classe.

**Il punto delicato di `commit()`**: le rotazioni pendenti sono tracciate per `id` di pagina originale, ma se nel frattempo altre pagine sono state eliminate, la posizione finale di una pagina superstite cambia. `commit()`/`exportBytes()` rimappano quindi ogni rotazione pendente dalla vecchia `id` alla **nuova posizione** (l'indice della pagina superstite dopo `compose_pdf`), prima di chiamare `rotate_pages`. Se elimini pagina 2 e vuoi ruotare l'originale pagina 3 di un documento di 4 pagine, dopo il commit la rotazione deve finire sulla pagina in posizione 2 (non 3) del documento risultante da 3 pagine.

**Undo/redo (`undo()`/`redo()`/`canUndo()`/`canRedo()`/`clearHistory()`)**: la cronologia vive in `PdfDocument`, non in `PdfEditor`, perché è lì che vive tutto lo stato mutabile. Ogni metodo che cambia qualcosa spinge prima uno snapshot su uno stack (`MAX_HISTORY = 50` passi, poi si scarta il più vecchio), e una nuova azione dopo un `undo()` svuota lo stack di redo (semantica standard).

Due scelte non ovvie:

- **Lo snapshot è dello stato *completo*, non solo di quello pendente** — include `bytes`, `pageCount` e la cache delle preview, non solo `rotations`/`deletions`/`order`. Costa pochissimo perché si copiano solo i *contenitori*: i buffer PDF e i PNG non vengono mai mutati in place (ogni operazione produce un `Uint8Array` nuovo), quindi lo snapshot ne tiene un riferimento a testa. In cambio sono annullabili anche `commit()`, `encrypt()` e `decrypt()` — proprio le operazioni dove un errore costerebbe di più — e annullarle è una pura sostituzione di riferimenti: nessuna chiamata wasm, e nessun ri-rendering, dato che la cache delle preview torna indietro insieme alla baseline a cui apparteneva.
- **Lo snapshot si registra solo se la mutazione cambia davvero qualcosa** — ogni `pushUndo()` sta *dopo* le validazioni e gli early-return già presenti (`restorePage` su una pagina non eliminata, `movePage` verso la posizione in cui la pagina già si trova, `rotatePage(id, 360)`, un `commit()` senza modifiche pendenti…). Altrimenti la cronologia si riempirebbe di passi invisibili e un `undo()` non sembrerebbe fare nulla. Per le operazioni async (`commit`/`encrypt`/`decrypt`) lo stato "prima" è catturato in anticipo ma registrato solo a chiamata wasm riuscita, così un'operazione fallita non lascia un passo fantasma.

**Metadati (`getMetadata()` / `setMetadata(patch)`)**: i metadati `/Info` sono modifiche **pendenti** come rotazioni ed eliminazioni — si accumulano in memoria e si applicano su `commit()`, quindi entrano gratis nella cronologia undo/redo. La patch è a tre stati per campo (assente = non toccare, stringa = imposta, `null` = cancella), l'unica forma che distingue "svuota l'autore" da "non parlare dell'autore".

La lettura è **lazy e cachata**: `open()` fa deliberatamente la sola chiamata `page_count` e non renderizza nulla in automatico, quindi leggere `/Info` all'apertura spenderebbe un secondo round-trip wasm per documento su un dato che la maggior parte delle sessioni non guarda mai. `getMetadata()` legge la baseline alla prima chiamata e la cachea; la cache si invalida esattamente dove si invalida quella delle preview (`commit`/`encrypt`/`decrypt`), perché dipende dalla stessa identica cosa: i byte della baseline. Entrambe viaggiano dentro `DocumentSnapshot`, così annullare un commit riporta i metadati giusti senza rileggerli.

`setMetadata()` è **async** dove `rotatePage`/`deletePage` sono sincroni, per una ragione reale: decidere se una modifica cambia davvero qualcosa richiede di sapere cosa il documento già dice, e quello sta nel PDF. Legge la baseline da sé invece di pretendere che il chiamante abbia chiamato prima `getMetadata()` — dopo un `commit()` quella cache è azzerata, e quel requisito sarebbe stato una trappola.

**Trabocchetto risolto qui**: `compose_pdf` (e `merge_pdfs`) costruiscono un `Document` nuovo di zecca e vi riportano solo `/Root` — mai `/Info`. Quindi un commit che passa da `compose_pdf` (cioè con un'eliminazione o un riordino) **cancellava i metadati come effetto collaterale**. `computeCommittedBytes()` ora, quando la sequenza delle pagine cambia, riscrive l'intera baseline dei metadati sopra le modifiche pendenti, non solo le modifiche.

**Timeline navigabile (`history()` / `goToHistoryIndex(index)`)**: ogni snapshot porta con sé un'etichetta che descrive *come si è arrivati a quello stato* ("Elimina pagina 2", "Conferma modifiche (3 pagine)"), non l'azione che ne esce — così la lista è semplicemente `[stati passati…, stato corrente, stati annullati…]`, con lo stato iniziale sempre all'indice 0 ("Documento aperto"). `history()` la restituisce in ordine cronologico con `current: true` su una sola voce; l'etichetta dello stato corrente vive in un campo a parte (`currentLabel`) finché quello stato non diventa passato o futuro. `goToHistoryIndex(index)` salta a qualunque voce **rigiocando `undo()`/`redo()`** finché non ci arriva, invece di avere una propria logica di ripristino: un percorso di codice solo, niente da tenere allineato. Nell'editor questo è il riquadro "Cronologia modifiche (debug)" sotto la toolbar — una riga per passo, quella corrente evidenziata, quelle annullate in grigio, e un click salta direttamente a quello stato per quanti passi siano.

Merge e split restano **fuori** da questa cronologia: creano documenti *nuovi* invece di mutarne uno, quindi non c'è uno stato precedente da ripristinare dentro un singolo `PdfDocument` — annullare un merge sarebbe un'operazione a livello di `PdfEditor` (rimuovere il documento risultante), che è un'altra cosa.

Nota correlata: `hasPendingChanges()` conta anche un **riordino** pendente, non solo rotazioni/eliminazioni. Senza, un documento con le sole pagine riordinate risulterebbe "pulito" e `exportBytes()` restituirebbe la baseline non riordinata.

**Cache delle preview**: `getPreview`/`getPreviews` tengono una `Map<string, Uint8Array>` interna, chiave `${id}:${scale}`. Le renderizzazioni sono cachate perché dipendono solo dai byte della baseline corrente, **mai** dalle modifiche pendenti — `getPreview` renderizza sempre la pagina così com'è nella baseline (vedi sopra), quindi `rotatePage`/`deletePage`/`restorePage`/`resetRotation` non devono invalidare nulla: la stessa card resta valida, cambiano solo i metadati (`pendingRotation`/`markedForDeletion`) che vengono ricalcolati al volo a ogni chiamata, indipendentemente dalla cache. Solo un cambio della baseline stessa la invalida (`this.previewCache.clear()` in `commit()`, `encrypt()`, `decrypt()`). `getPreviews()` riusa quello che è già in cache e chiede al worker/pool solo le pagine effettivamente mancanti (`renderPagesInParallel` accetta un elenco di numeri di pagina arbitrario, non necessariamente contiguo, proprio per questo).

**Perché non una cache globale**: la cache è per-istanza, non condivisa tra `PdfDocument` diversi. Un tentativo di cache globale keyed per contenuto richiederebbe un hash semantico del content stream risolto di ogni pagina (indipendente dalla rinumerazione degli oggetti che `compose_pdf`/`merge_pdfs` fanno), più una strategia di eviction per non crescere all'infinito — complessità reale per un beneficio limitato a pochi casi. Invece, dove serve davvero (il merge, sotto), `mergeDocuments()` **trasferisce miratamente** le entry già calcolate invece di condividerle globalmente: `PdfDocument` espone due metodi `@internal` non pensati per uso generico — `cachedEntriesForPage(id)` (legge tutte le entry cachate per una pagina, a qualunque scala) e `primeCache(id, scale, png)` (ne inserisce una) — usati solo da `PdfEditor.mergeDocuments()`, che sa già esattamente quale pagina del risultato corrisponde a quale (documento sorgente, pagina originale) dato che `merge_pdfs` concatena le pagine di ogni sorgente in ordine. Verificato con la stessa prova di uguaglianza di **riferimento** usata altrove (`mergedPreviews[0].png === aPreviews[0].png`): se il trasferimento non fosse avvenuto, il rendering sarebbe stato rifatto da capo e avrebbe prodotto un `Uint8Array` diverso, anche a parità di contenuto.

**`getPreviews(scale, options)`** accetta anche due opzioni, entrambe pensate per i documenti grandi:

- **`onProgress?: (done: number, total: number) => void`** — chiamato dopo ogni pagina completata (anche le cache hit contano come "fatte" all'istante, così una barra di avanzamento riflette davvero quante pagine sono pronte, non solo quelle effettivamente renderizzate). Con più worker le pagine completano fuori ordine, quindi `done` avanza a scatti non uniformi — non un progresso lineare nel tempo, ma comunque un conteggio reale, non simulato.
- **`range?: { start, end }`** (1-indicizzato, inclusivo) — renderizza solo una finestra del documento invece di tutte le pagine. Si appoggia alla stessa cache e alla stessa logica "solo le mancanti" di sopra: chiedere due finestre che si sovrappongono non rirenderizza le pagine già viste. Un range che esce dai limiti del documento fa fallire la chiamata esplicitamente invece di essere silenziosamente troncato.

Nell'editor la barra di avanzamento **non** è un `<progress>` in fondo alla pagina, ma un riempimento verde sulla pill del documento nella doclist, subito sotto l'area di drag & drop (`<pdf-editor-app>`): `<pdf-document-view>` non mostra nulla da sé, dispatcha solo un evento `preview-progress` `{ done, total }` a ogni tick di `onProgress` (in `refresh()`); `<pdf-editor-app>` lo intercetta e aggiorna la larghezza (`%`) di un `div.fill` posizionato dietro checkbox/etichetta nel `<li>` corrispondente al documento attivo. A rendering completato (`done === total`), la pill resta riempita al 100% e prende un bordo verde (`.render-done`) — non sparisce, è il feedback di completezza richiesto. Quel bordo/riempimento resta finché non parte un nuovo rendering sullo stesso documento (es. dopo un altro `commit()`), che lo azzera e lo ricostruisce da capo.

**Punto delicato**: `document-committed` (dispatchato da `<pdf-document-view>` dopo il proprio `refresh()` interno al commit) fa ricostruire l'intera doclist (`renderDocList()`, nuovi `<li>` da zero) — il che perderebbe subito lo stato "completato" appena raggiunto. Il gestore di quell'evento in `<pdf-editor-app>` quindi marca esplicitamente come "done" la pill del documento attivo subito dopo la ricostruzione, invece di aspettarsi che sopravviva alla ricostruzione da sola — **tranne** sopra `VIRTUAL_SCROLL_THRESHOLD` (vedi sotto), dove quella pill non va mai marcata "done".

**Undo/redo nella UI**: i pulsanti "Annulla"/"Ripeti" nella toolbar di `<pdf-document-view>` rispecchiano `canUndo()`/`canRedo()` (disabilitati quando non c'è niente da fare), e le scorciatoie `Cmd/Ctrl+Z` / `Cmd+Shift+Z` / `Ctrl+Y` sono registrate su `window`, non sullo shadow root: con il focus sul body — il caso normale mentre si guarda la griglia — l'evento da tastiera non arriverebbe mai al sottoalbero del componente. Il listener ignora gli eventi originati da un campo editabile e viene rimosso in `disconnectedCallback`. A differenza di rotate/delete (che aggiornano la singola card), un passo di cronologia richiede un `refresh()` completo: può essere un riordino o un commit annullato, che cambiano tutta la griglia e il numero di pagine. Il re-render è comunque istantaneo perché la cache delle preview torna indietro con lo snapshot; se il numero di pagine è cambiato viene rilanciato `document-committed`, così la doclist esterna si ridisegna con il conteggio giusto.

**Pannello metadati**: un secondo `<details>` in `<pdf-document-view>`, sopra la cronologia. I valori si caricano all'**apertura** del pannello (evento `toggle`), non a ogni `refresh()` — è ciò che rende utile la lettura lazy del modello: chi non lo apre non paga mai la chiamata wasm. Le modifiche arrivano al modello su `change`, **non** su `input`: altrimenti ogni tasto premuto diventerebbe un passo di cronologia, mentre ogni altra modifica dell'editor è un passo per azione deliberata. Un campo svuotato significa "cancella la chiave", non "salva una stringa vuota" (l'intento di gran lunga più comune, anche se il PDF saprebbe distinguerli). I campi con una modifica non confermata prendono un bordo blu, così si vede cosa scriverebbe "Conferma modifiche". Dopo un undo/redo o un salto nella cronologia il pannello si risincronizza da solo, **saltando il campo che ha il focus** per non sfilare il testo da sotto le dita di chi sta scrivendo.

### Scroll virtuale nell'editor sopra soglia (`VIRTUAL_SCROLL_THRESHOLD`)

`refresh()` in `<pdf-document-view>` sceglie tra due strategie in base a `doc.getPageCount()`:

- **Sotto `VIRTUAL_SCROLL_THRESHOLD`** (24 pagine) — invariato: `getPreviews()` eager su tutte le pagine, con `onProgress` che alimenta la pill come descritto sopra.
- **Sopra soglia** (`refreshVirtual()`) — crea subito una `<pdf-page-card>` segnaposto per ogni pagina (`card.data = info`, solo metadati `PageInfo`, nessun `png` — vedi sotto), poi osserva ogni card con un `IntersectionObserver` (`rootMargin: "600px 0px"`, per precaricare un po' prima che la card sia davvero visibile). Quando una o più card entrano in vista, le loro posizioni finiscono in un batch (`pendingPositions`, svuotato al prossimo microtask con `queueMicrotask` — così più card che entrano in vista nello stesso frame diventano una sola raffica di chiamate, non una per card) raggruppato in run contigue (gap massimo `MAX_RANGE_GAP` = 3 posizioni: uno scroll che salta da pagina 1 a pagina 100 diventa due chiamate separate, non una che renderizza anche le 98 pagine di mezzo). Ogni run diventa una chiamata `getPreviews(scale, { range })`, che riusa la cache e la logica "solo le mancanti" già esistenti — per questo scorrere avanti e indietro non rirenderizza nulla di già visto. Una volta che una card riceve il suo PNG, viene tolta dall'observer (`unobserve`).
- **Niente evento `preview-progress` nel percorso virtuale**: questo documento non è mai stato pensato per "finire di renderizzare tutto insieme", quindi non emette mai quell'evento — la pill del documento in `<pdf-editor-app>` resta quindi neutra (nessun riempimento, nessun bordo verde), invece di mostrare un falso 100%. `<pdf-editor-app>` rinforza esplicitamente questo comportamento: il gestore di `document-committed` controlla `pageCount > VIRTUAL_SCROLL_THRESHOLD` prima di marcare una pill "done", proprio per non farlo per errore dopo un commit su un documento grande.
- **`disconnectedCallback()`** disconnette l'`IntersectionObserver` quando il componente viene rimosso, e `refresh()` disconnette sempre quello (eventuale) del giro precedente prima di procedere — altrimenti un observer vecchio continuerebbe a osservare card ormai sostituite.

**Card segnaposto senza PNG**: `<pdf-page-card>` accetta ora `card.data` di tipo `PagePreview | PageInfo` (rinominato da `card.preview`, che accettava solo `PagePreview`) — se l'oggetto ha un campo `png` mostra l'immagine come sempre, altrimenti mostra un rettangolo grigio pulsante (`.thumb--pending`) al suo posto. Rotazione/eliminazione funzionano comunque su una card ancora senza immagine, perché quelle azioni dipendono solo dall'`id` della pagina, mai dal suo bitmap.

**Verifica** (`www/e2e/editor.mjs`): usa `many_pages.pdf` (30 pagine, sopra soglia) con un viewport ridotto ad hoc (`page.setViewportSize({width: 380, height: 320})`, poi ripristinato) per rendere l'ultima pagina genuinamente fuori vista — verifica che tutte le 30 card segnaposto esistano subito, che l'ultima pagina non abbia ancora un PNG prima dello scroll, che `scrollIntoView()` su quella card ne causi il rendering, e che la pill del documento resti neutra (nessun riempimento, nessun bordo) per tutta la durata.

Lo stesso pattern è integrato anche nel pannello **Preview** del banco di prova a basso livello (`main.ts`), che non passa da `PdfDocument` ma chiama `page_count`/`render_page_preview`/`renderPagesInParallel` direttamente: un `<progress id="preview-progress">` si riempie a ogni pagina completata (nel ramo sequenziale come in quello col pool) e lo stato testuale mostra "Rendering anteprime… (n/m)" finché non è finito.

**Trabocchetto incontrato integrandolo**: `smoke.mjs` aveva un helper `waitForSettledStatus` che considerava "impostato" qualsiasi testo diverso da `"In corso…"` — con gli stati intermedi "Rendering anteprime… (n/m)" questo faceva risultare il test "concluso" alla prima pagina renderizzata, non a rendering finito. Corretto controllando esplicitamente che il testo inizi per `"Fatto"` o `"Errore"` (gli unici stati davvero terminali), non un generico "non è più In corso…". Tienilo a mente se aggiungi un altro pannello con stati di stato intermedi.

**Verifica** (`www/e2e/pdf-model.mjs`, `pnpm test:model`): stesso pattern di `smoke.mjs` (avvia Vite da solo, Chromium headless via Playwright), ma pilota le classi direttamente tramite una paginetta di solo test (`www/model-test.html` + `src/model-test-entry.ts`, che espone `window.__pdfModel = { PdfDocument, PdfEditor }`) invece che attraverso `index.html` — queste classi non hanno una UI propria. Copre, tra gli altri, il caso della rimappatura sopra: elimina una pagina, ruota un'altra, fa il commit, e verifica **concretamente** (non solo "non è andato in errore") che la rotazione sia finita sulla pagina giusta confrontando le dimensioni (larghezza/altezza) del PNG renderizzato prima e dopo — se `hayro` rispetta `/Rotate` (lo fa), una pagina ruotata di 90° ha dimensioni invertite rispetto all'originale. Copre anche la cache: la prova che una preview viene **davvero** servita dalla cache (non solo che il contenuto sembra uguale) è l'uguaglianza di **riferimento** dello stesso `Uint8Array` tra due chiamate (`first.png === second.png` dentro `page.evaluate`) — un rendering rifatto da capo produrrebbe sempre un nuovo `Uint8Array`, anche a parità di contenuto. E copre l'import immagini: `PdfEditor.addImage()` seguito da `mergeDocuments()` con un PDF vero, poi un `getPreview()` sul risultato — la prova che l'unione ha prodotto un documento *renderizzabile* (non solo strutturalmente valido), cioè che `Document::compress()` non ha corrotto il JPEG incorporato.

**Collegato anche alla UI**: la dropzone di `<pdf-editor-app>` accetta ora sia PDF che JPEG (`accept="application/pdf,image/jpeg"`; filtro lato JS in `pdf-io.ts`, `isPdf`/`isJpeg`, passato come parametro opzionale a `setupFileInput` — che di default resta PDF-only per gli altri pannelli). In `addFiles()`, un file JPEG passa da `editor.addImage()` invece che `editor.addDocument()`; da lì in poi appare nella lista documenti come un PDF qualunque (checkbox per il merge incluso) — non serve nessuna UI speciale per "unire immagini e PDF insieme", è la stessa lista, la stessa checkbox, lo stesso pulsante "Unisci i documenti selezionati".

Non collegato inizialmente a `main.ts`/`index.html` — quel collegamento visivo è la tab **Editor** descritta subito sotto.

### Editor visivo con Web Components (`src/webcomponents/`, tab "Editor")

Sopra `PdfDocument`/`PdfEditor` c'è un esempio con **Web Component nativi** (Custom Elements + Shadow DOM, nessun framework) che li wrappa visivamente — un'anteprima concreta di come un frontend reale (il futuro front Vue) potrebbe farlo, dato che i custom element si usano da qualunque framework, Vue incluso.

- **`<pdf-editor-app>`** (`pdf-editor-app.ts`) — crea e possiede una `PdfEditor`. Dropzone per aprire uno o più PDF, lista dei documenti aperti (con checkbox per selezionarli e unirli via `mergeDocuments`), e il documento attivo mostrato tramite `<pdf-document-view>`.
- **`<pdf-document-view>`** (`pdf-document-view.ts`) — wrappa un singolo `PdfDocument`: renderizza `getPreviews()` come una griglia di `<pdf-page-card>`, gestisce gli eventi `page-action` che risalgono da esse chiamando `rotatePage`/`deletePage`/`restorePage` sul documento, ed espone i pulsanti "Conferma modifiche" (`commit()`), "Scarica anteprima risultato" (`exportBytes()`) e "Scarica documento" (`getBytes()`).
- **`<pdf-page-card>`** (`pdf-page-card.ts`) — una singola card pagina: mostra il PNG, applica la rotazione pendente **via CSS** (`transform: rotate(...)`) invece di richiederla di nuovo al modello — coerente con la scelta di design di `PdfDocument.getPreview()` (vedi sopra: la preview non riflette le modifiche pendenti nel bitmap, solo nei metadati) — e mostra un overlay per le pagine marcate per l'eliminazione. Non tocca mai `PdfDocument` direttamente: dispatcha eventi `page-action` e `page-reorder` (`bubbles: true, composed: true` per attraversare i confini di ogni shadow root) e lascia che sia `<pdf-document-view>` a decidere cosa fare.

**Punto pratico**: ruotare/eliminare/riordinare una pagina nell'editor non fa **nessuna** chiamata wasm — sono mutazioni locali su `PdfDocument` (`Map`/`Set`/array in memoria), quindi la card si aggiorna all'istante (il riordino richiama `refresh()`, ma essendo tutte le pagine già in cache è comunque praticamente istantaneo, non un vero re-render). Solo `commit()` (via `compose_pdf`/`rotate_pages`) e l'apertura iniziale (`page_count` + `getPreviews()`) toccano davvero il worker/wasm.

**Riordino via drag & drop**: `<pdf-page-card>` è draggable con la API HTML5 Drag and Drop nativa (`dragstart`/`dragover`/`drop`), non con gestione manuale dei puntatori. Il `draggable="true"` viene impostato in `connectedCallback()`, **non nel costruttore** — lo spec dei Custom Element vieta esplicitamente di impostare attributi nel costruttore (side effect osservabile prima che l'elemento sia collegato al documento); farlo lì fa fallire `document.createElement` con `"The result must not have attributes"` per **ogni** istanza creata dopo la prima, un errore facile da non collegare alla causa vera.

Il riordino si applica **live durante il drag**, non solo al rilascio: ogni card in hover dispatcha `page-drag-over` con `{draggedId, targetId}` (non `page-reorder` al `drop` come nella prima versione), e `<pdf-document-view>` chiama subito `doc.movePage()` — la logica di riordino vera vive in `PdfDocument` (campo `order`, permutazione dei numeri di pagina originali), non nel componente. Una nota tecnica sulla API nativa: `dataTransfer.getData()` è leggibile solo durante `dragstart`/`drop`, **non** durante `dragover` (restrizione di sicurezza del browser) — quindi l'id della pagina trascinata è tenuto in una variabile a livello di modulo (`activeDragId` in `pdf-page-card.ts`, valida perché può esserci un solo drag attivo alla volta), non letto dal `dataTransfer` a ogni `dragover`.

Lo spostamento visibile delle card mentre trascini usa la tecnica **FLIP** (First / Last / Invert / Play, in `handlePageDragOver`): prima di riordinare, registra la posizione (`getBoundingClientRect()`) di ogni card; riordina i nodi DOM veri (`grid.appendChild` su un nodo già presente lo sposta, non lo duplica) per riflettere il nuovo ordine del modello; poi, per ogni card la cui posizione è cambiata, la salta istantaneamente indietro alla posizione di partenza via `transform` (con `transition: none`) e, al frame successivo, rimuove il transform lasciando che la `transition` la porti fluidamente alla posizione reale — è quello che dà l'effetto "le altre pagine si spostano per farti spazio" invece di uno scatto secco solo al rilascio.

Registrati una sola volta con un side-effect import (`import "./webcomponents"` in `main.ts`) prima che i tag vengano usati nel markup di `index.html` (tab "Editor" → `<pdf-editor-app></pdf-editor-app>`).

**Verifica** (`www/e2e/editor.mjs`, `pnpm test:editor`): stesso pattern delle altre suite, ma attraversa gli shadow root reali (`el.shadowRoot.querySelector(...)`) invece del DOM normale. Copre il flusso completo: apertura di due documenti, drag & drop reale tramite `locator.dragTo()` di Playwright (non un evento sintetico — un vero `DataTransfer`), rotazione + eliminazione (verificate come stato locale, non come chiamate), commit (il conteggio pagine scende), merge dei due documenti — con la rotazione committata sulla prima pagina ancora visibile nel documento unito finale, prova che sopravvive all'intera pipeline (rotate pendente → commit → merge) — l'import di un JPEG unito a un PDF vero (una pagina in più nella griglia, renderizzata correttamente) — e infine la barra di avanzamento sulla pill: apre `ten_pages.pdf` e verifica che il riempimento della pill cresca durante il rendering (`0% < width < 100%`) e che finisca marcata "done" (riempimento al 100% + `.render-done`) una volta completato. Il test del riordino a livello di modello (rimappatura della rotazione sulla pagina spostata dopo `commit()`) vive invece in `pdf-model.mjs`, più mirato e senza bisogno di un vero drag.

### Nota su Vite e `pkg/`/`pkg-full/`

`www/vite.config.ts` imposta `server.fs.allow: [".."]`: senza questa opzione Vite risponde `403` quando la pagina prova a caricare `../pkg/pdfrs_bg.wasm` o `../pkg-full/pdfrs_bg.wasm`, perché quei file stanno fuori dalla root del progetto `www/`.

## Package manager

Il progetto usa **pnpm** per `www/` (non npm/yarn): `pnpm install`, `pnpm add -D <pacchetto>@latest` per aggiornare le dipendenze. Il lockfile è `www/pnpm-lock.yaml`.
