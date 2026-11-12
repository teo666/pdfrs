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

