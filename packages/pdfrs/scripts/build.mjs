import { copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(label, command, args, cwd) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) {
    console.error(`Unable to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("Building full WebAssembly", "wasm-pack", ["build", "--target", "web", "--out-dir", "pkg-full"], projectRoot);
run("Installing library build tools", pnpm, ["install"], packageRoot);
run("Bundling the TypeScript library", pnpm, ["exec", "vite", "build", "--config", `${packageRoot}/vite.config.ts`], packageRoot);
run("Generating TypeScript declarations", pnpm, ["exec", "tsc", "-p", `${packageRoot}/tsconfig.json`], packageRoot);

copyFileSync(`${projectRoot}/LICENSE-MIT`, `${packageRoot}/dist/LICENSE-MIT`);
copyFileSync(`${projectRoot}/LICENSE-APACHE`, `${packageRoot}/dist/LICENSE-APACHE`);
