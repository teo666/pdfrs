import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const wwwRoot = fileURLToPath(new URL("../../www", import.meta.url));
const packageWorkerFactory = fileURLToPath(new URL("./src/create-pdfrs-worker.ts", import.meta.url));

export default defineConfig({
  root: wwwRoot,
  base: "./",
  publicDir: false,
  resolve: {
    alias: [
      { find: "./create-pdfrs-worker.js", replacement: packageWorkerFactory },
    ],
  },
  optimizeDeps: {
    exclude: ["pdfrs", "pdfrs-full"],
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    outDir: `${packageRoot}/dist`,
    emptyOutDir: true,
    rollupOptions: {
      input: `${wwwRoot}/src/library.ts`,
      preserveEntrySignatures: "strict",
      output: {
        format: "es",
        entryFileNames: "index.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
