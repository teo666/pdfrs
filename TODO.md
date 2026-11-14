# TODO

Idee di funzionalità discusse e non ancora implementate.

## Lista di lavoro

I punti decisi, nell'ordine in cui si fanno. Ogni PR spunta il suo.

1. [ ] **Rilascio di `pdfrs.js` 0.3.0** — CropBox, `replace_image`/`compress_images`, `PreviewDocument` e quello che arriva dai punti sotto. Versione e changelog; la pubblicazione su npm la conferma l'utente.
2. [ ] **Prima release dell'app** (tag `v0.1.0` in pdfrs-app): zip dell'estensione per Chrome e Firefox e della build web, con il workflow `release.yml` che c'è già.
3. [ ] **Pulizia** — branch già mergiati; action ferme a Node 20 (`configure-pages`, `deploy-pages`, `pnpm/action-setup`, `upload-artifact`).
4. [x] **Togliere solo la rotazione** di una o più pagine: il badge «90° ×» della miniatura e del visualizzatore, e un pulsante nella barra delle pagine selezionate (`PdfDocument.resetRotations`, un solo passo di cronologia).
5. [x] **Filigrana di testo e pagine bianche** — `watermark_pdf` (sopra o sotto il contenuto, opacità con `/ExtGState`, dimensione adatta alla pagina o in punti, angolo, posizione, pagine scelte), `blank_page_pdf`, `page_sizes`; `annotate_pdf` guadagna `opacity` e `layer`. Nell'app lo strumento «Filigrana» (applicata subito, annullabile, con anteprima) e «Pagina bianca» nella barra del documento.
6. [x] **Indice, fase 2** — nel modello `addOutlineEntry`, `renameOutlineEntry`, `removeOutlineEntry`, `moveOutlineEntry`, `indent…`/`outdentOutlineEntry`: modifiche in sospeso, annullabili. `setOutlineOpen` vale anche dopo «Applica modifiche». Le pagine inserite o spostate da un altro documento portano le loro voci, e `outline.rs` tiene link URI, colore e stile. Nell'app, i comandi del pannello «Indice» e la tastiera (F2, Alt+frecce, Canc).
7. [x] **Permessi del PDF protetto** — `encrypt_pdf(…, { permissions })` e `read_permissions`. Nel pannello «Proteggi», sette caselle e la «password per togliere le limitazioni», obbligatoria e diversa da quella di apertura. Le limitazioni di un file aperto o sbloccato compaiono in «Proteggi» e «Proprietà».
8. [x] **Immagini, fase 3** — `move_images` sposta e ridimensiona un'immagine già nel PDF: avvolge il disegno in `q <delta> cm … Q`, così gli id restano gli stessi. Rifiuta le Form condivise tra pagine; `clipped` segnala quelle ritagliate. Nel modello `PdfDocument.moveImage` si applica subito ed è annullabile. Nel visualizzatore dell'app ci sono le maniglie sull'immagine selezionata: la scatola sposta, l'angolo ridimensiona, i lati allungano, Esc annulla.
9. [ ] **Miniature più veloci da disegnare** — misurare prima quanto pesa la codifica PNG rispetto al disegno; poi scala più bassa, WebP o bitmap, profilo di hayro.

## Altre idee

- [x] **Possibilità di mettere la firma** — apposizione di immagini PNG (con trasparenza) su pagine esistenti (`annotate_pdf`), con pannello nella pagina di test.
- [ ] **Simple pdf viewer**
- [x] **fascicolatura / booklet** — imposizione a libretto piegato al centro (saddle-stitch), riordino automatico a multipli di 4, supporto fronte/retro e direzione di rilegatura (`booklet_pdf`).
- [x] **pdf multipagina / N-up** — layout a griglia con $N$ pagine per foglio (1, 2, 4, 6, 8, 9, 16 o custom), margini, spacing, bordi, orientamento e auto-rotazione (`nup_pdf`).
- [x] **rimozione immagini (fase 1)** — elenco delle immagini già nel PDF con posizione, scarico (JPEG originale o PNG), rimozione in sospeso da una pagina o da tutte (`images.rs`, `image_extract.rs`, strumento «Immagini» dell'app).
- [x] **Immagini, fase 2** — sostituire un'immagine (ovunque sia disegnata, adattata nel riquadro con margini trasparenti: `replace_image`) e alleggerire il file ricomprimendo le immagini in una copia (`compress_images`, tre livelli). `image_edit.rs`; strumento «Immagini» dell'app.
- [ ] rimozione firma digitale
- [ ] creazione firma digitale

## Già nella libreria, da portare nell'app (pdfrs-app)

In ordine di priorità suggerito.

- [x] **Pannello "Proprietà": i metadati del documento** — titolo, autore, oggetto, parole chiave, creator, producer, date. Il motore li legge e scrive (`read_metadata`/`write_metadata`) e il modello li gestisce già come una modifica in sospeso (`PdfDocument.getMetadata()`/`setMetadata()`: lettura lazy, annullabili, applicati con il commit). Utile per correggere il titolo che i lettori PDF mostrano al posto del nome del file, o per togliere l'autore prima di condividere.
- [x] **Cronologia delle modifiche** — il modello tiene una cronologia con un'etichetta per ogni passo ("Conferma modifiche (12 pagine)", il nome dell'immagine inserita…) e può saltare a un punto preciso (`history()`, `goToHistoryIndex()`); l'app ha solo Annulla/Ripeti. Un pannello con l'elenco permetterebbe di tornare indietro di più passi in un clic e di vedere cosa si annulla.
- [x] **Pagina A4/Letter per i JPEG** — ogni foto aperta o inserita va sulla pagina e col margine predefiniti (A4, 1 cm, ricordati); nel visualizzatore si cambiano foto per foto (A4 / Letter / dimensione reale; margine nessuno / 0,5 / 1 / 2 cm) con «Usa per le prossime foto» (`setPhotoPage`, opzione `margin` di `image_to_pdf`).
- [x] **Indice del PDF (segnalibri)** — strumento «Indice» (albero, voce → vai alla miniatura); l'indice resta con eliminazioni, riordini, estrazioni, inserimenti e unioni (un ramo per documento). `outline.rs`, `remapOutline` nel modello.
- [x] **`stamp.rs` usa la MediaBox, le anteprime la CropBox** — firme, immagini e testo ora si posizionano sulla parte di pagina mostrata (CropBox∩MediaBox, `nup::get_visible_box`, la stessa di `images.rs`).
- [x] **N per foglio e libretto ignorano la CropBox** — ogni pagina diventa una Form con il `BBox` sulla parte mostrata (`create_page_form_xobject` usa `get_visible_box`): sul foglio arriva solo quella, e «formato originale» è quello della pagina mostrata.

## Ottimizzazioni future

- [x] **Documento già letto tenuto nel worker, lato Rust** — `PreviewDocument` (`src/operations/preview.rs`, esportato in wasm): legge il file una volta e tiene `Pdf` e `RenderCache`; il worker lo tiene al posto dei byte e lo libera (`free()`) quando il pool gli dice `release`. Misurato con `www/e2e/preview-bench.mjs` su un solo worker: libro da 44 MB da ~38 a ~31 ms per miniatura, 8 MB da ~24,5 a ~21, file piccoli invariati. Il resto è il disegno della pagina in sé.

