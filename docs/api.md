# API esposta

Tutte le funzioni sono esportate da `pkg/pdfrs.js` (generato da `wasm-pack build --target web`) e sono `async`: ritornano una `Promise` che si risolve con i byte del PDF risultante, o viene rigettata con un `Error` leggibile in caso di problema (range di pagina invalido, password sbagliata, ecc.).

Prima di chiamarle va inizializzato il modulo wasm una sola volta:

```ts
import init, {
  merge_pdfs, split_pdf, rotate_pages, compose_pdf, encrypt_pdf, decrypt_pdf,
  page_count, render_page_preview, image_to_pdf,
} from "pdfrs";

await init();
```

Chiamarle così, direttamente sul thread principale, **blocca la UI** per la durata dell'operazione (sono `async` solo nel senso che ritornano una `Promise`, non nel senso che girano su un altro thread). Per non bloccare la pagina vanno eseguite dentro un **Web Worker** — vedi [`development.md`](development.md#il-modulo-wasm-gira-in-un-web-worker-non-sul-thread-principale) per il pattern completo (`www/src/pdfrs.worker.ts` + `www/src/pdfrs-worker-client.ts`), che espone queste stesse funzioni con le stesse firme ma passando da un worker.

## `merge_pdfs(files: Uint8Array[]): Promise<Uint8Array>`

Concatena le pagine di più PDF, nell'ordine dell'array, in un unico PDF.

```ts
const merged = await merge_pdfs([bytesA, bytesB]);
```

## `split_pdf(file: Uint8Array, ranges): Promise<Uint8Array[]>`

Divide un PDF in più PDF, uno per ogni range richiesto. `ranges` è un array di oggetti `{ start, end }`, **1-indicizzati e inclusivi**.

```ts
const parts = await split_pdf(bytes, [
  { start: 1, end: 2 },
  { start: 3, end: 4 },
]);
```

## `rotate_pages(file: Uint8Array, rotations): Promise<Uint8Array>`

Ruota singole pagine. `rotations` è un array di `{ page, degrees }`; `degrees` viene **sommato** alla rotazione corrente della pagina e deve essere un multiplo di 90 (anche negativo, es. `-90`).

```ts
const rotated = await rotate_pages(bytes, [{ page: 1, degrees: 90 }]);
```

## `compose_pdf(sources: Uint8Array[], layout): Promise<Uint8Array>`

Costruisce un nuovo PDF scegliendo pagine da più PDF sorgente, in qualsiasi ordine (riordino, interleaving, pagine ripetute). `layout` è un array di `{ source, page }`, dove `source` è l'indice del file dentro `sources` e `page` è il numero di pagina (1-indicizzato) in quel documento sorgente.

```ts
// pagina 1 del secondo file, poi pagina 2 e pagina 1 del primo file
const composed = await compose_pdf([bytesA, bytesB], [
  { source: 1, page: 1 },
  { source: 0, page: 2 },
  { source: 0, page: 1 },
]);
```

## `encrypt_pdf(file: Uint8Array, ownerPassword: string, userPassword: string): Promise<Uint8Array>`

Cifra il PDF con AES-256 (PDF 2.0, revisione 6 — lo schema più forte supportato). `userPassword` è richiesta per aprire il documento; `ownerPassword` per cambiarne i permessi o rimuovere la cifratura. Fallisce se il documento è già cifrato.

```ts
const encrypted = await encrypt_pdf(bytes, "owner-secret", "user-secret");
```

## `decrypt_pdf(file: Uint8Array, password: string): Promise<Uint8Array>`

Decifra un PDF usando la password owner o user. Se il file non è cifrato, la funzione ritorna semplicemente il PDF invariato (no-op). Con una password errata la Promise viene rigettata.

```ts
const decrypted = await decrypt_pdf(encryptedBytes, "user-secret");
```

## `page_count(file: Uint8Array): Promise<number>`

Ritorna il numero di pagine di un PDF. Utile per sapere quante anteprime richiedere a `render_page_preview`.

```ts
const count = await page_count(bytes);
```

## `render_page_preview(file: Uint8Array, page: number, scale: number): Promise<Uint8Array>`

Renderizza `page` (1-indicizzata) in un'immagine PNG, per una preview/thumbnail nel frontend. `scale` moltiplica la dimensione nativa della pagina (es. `0.4` per una miniatura piccola, `1.5` per una preview più nitida). Si aspetta byte **già decriptati** — per un PDF cifrato, passa prima l'output di `decrypt_pdf`.

```ts
const count = await page_count(bytes);
for (let page = 1; page <= count; page++) {
  const png = await render_page_preview(bytes, page, 0.4);
  const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
  // usa `url` come src di un <img> per mostrare la card della pagina
}
```

## `image_to_pdf(file: Uint8Array, options): Promise<Uint8Array>`

Converte un **JPEG** in un PDF di una pagina, così può essere unito/combinato con PDF veri usando `merge_pdfs`/`compose_pdf` senza altro codice — una volta convertita, per il resto dell'API è un PDF come un altro. Solo JPEG per ora (RGB o scala di grigi; i JPEG CMYK vengono rifiutati); i byte JPEG sono incorporati così come sono (`/Filter /DCTDecode`), senza ridecodificare i pixel.

`options` (tutti i campi opzionali, `{}`/`undefined`/`null` vanno bene):

```ts
interface ImagePageOptions {
  pageSize?: "native" | "a4" | "letter"; // "native" (default): la pagina è grande esattamente quanto l'immagine
  orientation?: "portrait" | "landscape" | "auto"; // ignorato con "native"; "auto" (default) segue l'aspect ratio dell'immagine
}
```

```ts
// pagina grande quanto l'immagine stessa
const imagePdf = await image_to_pdf(jpegBytes, {});

// su una pagina A4, centrata e scalata per stare dentro i margini
const onA4 = await image_to_pdf(jpegBytes, { pageSize: "a4" });

// combinarla con un PDF vero è già tutto qui, nessuna API nuova
const combined = await merge_pdfs([imagePdf, otherPdfBytes]);
```

## Gestione errori

Ogni funzione rigetta la Promise invece di lanciare un'eccezione non gestita o mandare in panic il modulo wasm. Esempio:

```ts
try {
  await decrypt_pdf(bytes, "wrong-password");
} catch (err) {
  console.error(err); // Error: failed to read PDF: invalid password for encrypted PDF
}
```

Vedi anche [`../www/src/main.ts`](../www/src/main.ts) per un esempio completo di integrazione di tutte le funzioni in una pagina reale.
