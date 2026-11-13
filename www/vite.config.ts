import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // "pdfrs-editor" is linked from ../packages/pdfrs-editor, and through it
    // the wasm package from ../pkg-npm - both outside this project's root, so
    // Vite's dev-server file-system guard must be told to allow them or the
    // module/.wasm fetches get a 403. Linked packages outside node_modules
    // are served as source (never pre-bundled), so a wasm-pack rebuild is
    // picked up without any optimizeDeps cache to clear.
    fs: {
      allow: [".."],
    },
  },
});
