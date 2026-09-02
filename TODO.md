# TODO

Idee di funzionalità discusse e non ancora implementate.

- [ ] **Undo/redo nell'editor** — il modello (`PdfDocument`) già tiene stato pendente pulito (`rotations`, `deletions`, `order`); uno stack di snapshot preso prima di ogni mutazione lo renderebbe quasi gratis da aggiungere sopra.
- [ ] **Pagina bianca / watermark** — stesso pattern di `image_to_pdf` (costruire un content stream/pagina da zero) applicato a una pagina vuota o a un testo/immagine stampato sopra pagine esistenti.
- [ ] **Metadati documento** — titolo, autore, keyword: manipolazione diretta del dizionario `/Info` via lopdf.
- [ ] **Riordino di pagine tra documenti diversi nell'editor** — trascinare una pagina dal documento A dentro il documento B; concettualmente un delete-da-A + compose-in-B, la logica sotto esiste già, serve solo lavoro di UI.
