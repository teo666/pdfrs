# TODO

Idee di funzionalità discusse e non ancora implementate.

- [ ] **Pagina bianca / watermark** — stesso pattern di `image_to_pdf` (costruire un content stream/pagina da zero) applicato a una pagina vuota o a un testo/immagine stampato sopra pagine esistenti.
- [ ] **Riordino di pagine tra documenti diversi nell'editor** — trascinare una pagina dal documento A dentro il documento B; concettualmente un delete-da-A + compose-in-B, la logica sotto esiste già, serve solo lavoro di UI.
- [x] **Possibilità di mettere la firma** — apposizione di immagini PNG (con trasparenza) su pagine esistenti (`annotate_pdf`), con pannello nella pagina di test.
- [ ] **Firma, N-up e booklet nell'editor** — oggi `annotate_pdf`, `nup_pdf` e `booklet_pdf` sono esposti solo nella pagina di test (`www/src/main.ts`), non nei web component dell'editor.
- [ ] **Simple pdf viewer**
- [x] **fascicolatura / booklet** — imposizione a libretto piegato al centro (saddle-stitch), riordino automatico a multipli di 4, supporto fronte/retro e direzione di rilegatura (`booklet_pdf`).
- [x] **pdf multipagina / N-up** — layout a griglia con $N$ pagine per foglio (1, 2, 4, 6, 8, 9, 16 o custom), margini, spacing, bordi, orientamento e auto-rotazione (`nup_pdf`).
- [ ] rimozione immagini
- [ ] rimozione firma digitale
- [ ] creazione firma digitale

## Già nella libreria, da portare nell'app (pdfrs-app)

In ordine di priorità suggerito.

- [ ] **Pannello "Proprietà": i metadati del documento** — titolo, autore, oggetto, parole chiave, creator, producer, date. Il motore li legge e scrive (`read_metadata`/`write_metadata`) e il modello li gestisce già come una modifica in sospeso (`PdfDocument.getMetadata()`/`setMetadata()`: lettura lazy, annullabili, applicati con il commit). Utile per correggere il titolo che i lettori PDF mostrano al posto del nome del file, o per togliere l'autore prima di condividere.
- [ ] **Cronologia delle modifiche** — il modello tiene una cronologia con un'etichetta per ogni passo ("Conferma modifiche (12 pagine)", il nome dell'immagine inserita…) e può saltare a un punto preciso (`history()`, `goToHistoryIndex()`); l'app ha solo Annulla/Ripeti. Un pannello con l'elenco permetterebbe di tornare indietro di più passi in un clic e di vedere cosa si annulla.
- [ ] **Pagina A4/Letter per i JPEG** — `image_to_pdf` e `PdfEditor.addImage` accettano `ImagePageOptions` (`pageSize`: `native`/`a4`/`letter`, `orientation`: `portrait`/`landscape`/`auto`); l'app usa sempre `native`, quindi una foto da telefono diventa una pagina enorme. Basta una scelta all'apertura o all'inserimento di un JPEG.
- [ ] **Togliere solo la rotazione** di una pagina (`PdfDocument.resetRotation`): oggi si ruota di nuovo o si annulla.
- [ ] **Permessi del PDF protetto** (stampa, copia del testo, modifica) — questo richiede prima il motore: `encrypt` in `src/operations/crypto.rs` usa `Permissions::default()`, cioè tutto consentito.

## Ottimizzazioni future

- [ ] **Documento già letto tenuto nel worker, lato Rust** — oggi i worker del pool di anteprime tengono i *byte* del documento (`preview-worker-pool.ts`: inviati una volta per worker, non più a ogni pagina), ma ogni pagina da renderizzare paga ancora, dentro il worker:
  - due copie dell'intero file: `file.to_vec()` da JS a wasm (`render_page_preview` in `src/lib.rs`), poi `bytes.to_vec()` per l'`Arc` di `Pdf::new` (`src/operations/preview.rs`);
  - la lettura del documento da capo (`Pdf::new`: xref, trailer, albero delle pagine);
  - una `RenderCache` nuova, quindi font e immagini condivisi tra le pagine decodificati di nuovo ogni volta.

  Idea: un oggetto wasm (es. `PreviewDocument`, `#[wasm_bindgen]`) costruito una volta dai byte, che tiene `Pdf` e `RenderCache` e ha `render_page(page, scale)`; il worker lo tiene al posto del `Uint8Array` nella mappa `heldDocuments` di `pdfrs.worker.ts` e lo libera (`free()`) quando il pool gli dice `release`. Il protocollo `hold`/`release` del pool resta com'è. Il guadagno è nel worker (tempo per pagina e memoria temporanea), non sul main thread, che è già libero: conta soprattutto per scansioni pesanti e documenti con molte pagine. Da misurare prima e dopo (es. PDF da ~40 MB di scansioni: oggi ~2-3 s per 15 pagine).

