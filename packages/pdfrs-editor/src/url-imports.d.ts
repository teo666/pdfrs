// Vite's `?url` suffix: the import resolves to the asset's public URL. Declared
// here (instead of pulling in `vite/client`) so the package type-checks the
// same way in every consumer, whatever its own tsconfig `types` are.
declare module "*?url" {
  const url: string;
  export default url;
}
