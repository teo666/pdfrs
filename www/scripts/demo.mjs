import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const wwwRoot = fileURLToPath(new URL("..", import.meta.url));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(label, command, args, cwd) {
  console.log(`\n==> ${label}`);

  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Impossibile eseguire ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(
  "Compilazione WASM core",
  "wasm-pack",
  ["build", "--target", "web", "--out-dir", "pkg", "--no-default-features", "--features", "console_error_panic_hook"],
  projectRoot,
);

run("Compilazione WASM full", "wasm-pack", ["build", "--target", "web", "--out-dir", "pkg-full"], projectRoot);
run("Aggiornamento dipendenze locali", pnpm, ["install"], wwwRoot);
run("Avvio demo", pnpm, ["dev"], wwwRoot);
