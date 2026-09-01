# API esposta

Tutte le funzioni sono esportate da `pkg/pdfrs.js` (generato da `wasm-pack build --target web`) e sono `async`: ritornano una `Promise` che si risolve con i byte del PDF risultante, o viene rigettata con un `Error` leggibile in caso di problema (range di pagina invalido, password sbagliata, ecc.).

Prima di chiamarle va inizializzato il modulo wasm una sola volta:

```ts
import init, {
  merge_pdfs, split_pdf, rotate_pages, compose_pdf, encrypt_pdf, decrypt_pdf,
} from "pdfrs";

await init();
```

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

## Gestione errori

Ogni funzione rigetta la Promise invece di lanciare un'eccezione non gestita o mandare in panic il modulo wasm. Esempio:

```ts
try {
  await decrypt_pdf(bytes, "wrong-password");
} catch (err) {
  console.error(err); // Error: failed to read PDF: invalid password for encrypted PDF
}
```

Vedi anche [`../www/src/main.ts`](../www/src/main.ts) per un esempio completo di integrazione di tutte e 6 le funzioni in una pagina reale.
