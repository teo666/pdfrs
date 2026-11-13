# TODO

Idee di funzionalità discusse e non ancora implementate.

- [ ] **Pagina bianca / watermark** — stesso pattern di `image_to_pdf` (costruire un content stream/pagina da zero) applicato a una pagina vuota o a un testo/immagine stampato sopra pagine esistenti.
- [ ] **Riordino di pagine tra documenti diversi nell'editor** — trascinare una pagina dal documento A dentro il documento B; concettualmente un delete-da-A + compose-in-B, la logica sotto esiste già, serve solo lavoro di UI.
- [x] **Possibilità di mettere la firma** — apposizione di immagini PNG (con trasparenza) su pagine esistenti (`annotate_pdf`), con pannello nella pagina di test.
- [ ] **Firma, N-up e booklet nell'editor** — oggi `annotate_pdf`, `nup_pdf` e `booklet_pdf` sono esposti solo nella pagina di test (`www/src/main.ts`), non nei web component dell'editor.
- [ ] **Simple pdf viewer**
- [x] **fascicolatura / booklet** — imposizione a libretto piegato al centro (saddle-stitch), riordino automatico a multipli di 4, supporto fronte/retro e direzione di rilegatura (`booklet_pdf`).
- [x] **pdf multipagina / N-up** — layout a griglia con $N$ pagine per foglio (1, 2, 4, 6, 8, 9, 16 o custom), margini, spacing, bordi, orientamento e auto-rotazione (`nup_pdf`).
- [x] **rimozione immagini (fase 1)** — elenco delle immagini già nel PDF con posizione, scarico (JPEG originale o PNG), rimozione in sospeso da una pagina o da tutte (`images.rs`, `image_extract.rs`, strumento «Immagini» dell'app).
- [ ] **Immagini, fase 2** — sostituire un'immagine mantenendone posizione e dimensione (riusando `stamp::add_image_object`); ricomprimere/ridurre le immagini per alleggerire il file (decodifica via hayro, ricodifica JPEG; JBIG2/JPX da saltare o convertire).
- [ ] **Immagini, fase 3** — spostare e ridimensionare un'immagine esistente (riscrivere la `cm` che la precede; attenzione a trasformazioni annidate e ritagli).
- [ ] rimozione firma digitale
- [ ] creazione firma digitale

## Già nella libreria, da portare nell'app (pdfrs-app)

In ordine di priorità suggerito.

- [x] **Pannello "Proprietà": i metadati del documento** — titolo, autore, oggetto, parole chiave, creator, producer, date. Il motore li legge e scrive (`read_metadata`/`write_metadata`) e il modello li gestisce già come una modifica in sospeso (`PdfDocument.getMetadata()`/`setMetadata()`: lettura lazy, annullabili, applicati con il commit). Utile per correggere il titolo che i lettori PDF mostrano al posto del nome del file, o per togliere l'autore prima di condividere.
- [x] **Cronologia delle modifiche** — il modello tiene una cronologia con un'etichetta per ogni passo ("Conferma modifiche (12 pagine)", il nome dell'immagine inserita…) e può saltare a un punto preciso (`history()`, `goToHistoryIndex()`); l'app ha solo Annulla/Ripeti. Un pannello con l'elenco permetterebbe di tornare indietro di più passi in un clic e di vedere cosa si annulla.
- [x] **Pagina A4/Letter per i JPEG** — ogni foto aperta o inserita va sulla pagina e col margine predefiniti (A4, 1 cm, ricordati); nel visualizzatore si cambiano foto per foto (A4 / Letter / dimensione reale; margine nessuno / 0,5 / 1 / 2 cm) con «Usa per le prossime foto» (`setPhotoPage`, opzione `margin` di `image_to_pdf`).
- [ ] **Togliere solo la rotazione** di una pagina (`PdfDocument.resetRotation`): oggi si ruota di nuovo o si annulla.
- [x] **Indice del PDF (segnalibri)** — strumento «Indice» (albero, voce → vai alla miniatura); l'indice resta con eliminazioni, riordini, estrazioni, inserimenti e unioni (un ramo per documento). `outline.rs`, `remapOutline` nel modello.
- [ ] **Indice, fase 2** — modificare le voci (aggiungere, rinominare, togliere, spostare); portare nel documento di destinazione le voci delle pagine trasferite; ricordare lo stato aperto/chiuso dei rami dopo un «Applica modifiche».
- [x] **`stamp.rs` usa la MediaBox, le anteprime la CropBox** — firme, immagini e testo ora si posizionano sulla parte di pagina mostrata (CropBox∩MediaBox, `nup::get_visible_box`, la stessa di `images.rs`).
- [ ] **N per foglio e libretto ignorano la CropBox** — `nup.rs` e `booklet.rs` impaginano la MediaBox intera, quindi di una pagina ritagliata mostrano anche la parte nascosta. Usare `get_visible_box` (e ritagliare con un clip) come nelle anteprime.
- [ ] **Permessi del PDF protetto** (stampa, copia del testo, modifica) — questo richiede prima il motore: `encrypt` in `src/operations/crypto.rs` usa `Permissions::default()`, cioè tutto consentito.

## Ottimizzazioni future

- [ ] **Documento già letto tenuto nel worker, lato Rust** — oggi i worker del pool di anteprime tengono i *byte* del documento (`preview-worker-pool.ts`: inviati una volta per worker, non più a ogni pagina), ma ogni pagina da renderizzare paga ancora, dentro il worker:
  - due copie dell'intero file: `file.to_vec()` da JS a wasm (`render_page_preview` in `src/lib.rs`), poi `bytes.to_vec()` per l'`Arc` di `Pdf::new` (`src/operations/preview.rs`);
  - la lettura del documento da capo (`Pdf::new`: xref, trailer, albero delle pagine);
  - una `RenderCache` nuova, quindi font e immagini condivisi tra le pagine decodificati di nuovo ogni volta.

  Idea: un oggetto wasm (es. `PreviewDocument`, `#[wasm_bindgen]`) costruito una volta dai byte, che tiene `Pdf` e `RenderCache` e ha `render_page(page, scale)`; il worker lo tiene al posto del `Uint8Array` nella mappa `heldDocuments` di `pdfrs.worker.ts` e lo libera (`free()`) quando il pool gli dice `release`. Il protocollo `hold`/`release` del pool resta com'è. Il guadagno è nel worker (tempo per pagina e memoria temporanea), non sul main thread, che è già libero: conta soprattutto per scansioni pesanti e documenti con molte pagine. Da misurare prima e dopo (es. PDF da ~40 MB di scansioni: oggi ~2-3 s per 15 pagine).

