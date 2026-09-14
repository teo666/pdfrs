import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    // These local wasm-pack packages must stay paired with their respective
    // .wasm assets. A cached optimized copy of the generated JS glue can be
    // incompatible with a freshly rebuilt binary because wasm-bindgen hashes
    // its import names.
    exclude: ["pdfrs", "pdfrs-full"],
  },
  server: {
    // The "pdfrs" package resolves to ../pkg (see package.json), outside this
    // project's root, so Vite's dev-server file-system guard must be told to
    // allow it or the .wasm fetch gets a 403.
    fs: {
      allow: [".."],
    },
  },
});
