import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["pdfrs"],
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
