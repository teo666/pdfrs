import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), "pdfrs-package-test-"));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function allFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    return entry.isDirectory() ? allFiles(join(directory, entry.name), relative) : [relative];
  });
}

try {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", testRoot, "--cache", join(testRoot, "npm-cache")], packageRoot);

  writeFileSync(
    join(testRoot, "package.json"),
    JSON.stringify(
      {
        name: "pdfrs-package-consumer",
        private: true,
        type: "module",
        dependencies: { pdfrs: "file:./pdfrs-0.1.0.tgz" },
        devDependencies: { typescript: "^7.0.2", vite: "^8.2.2" },
      },
      null,
      2,
    ),
  );
  mkdirSync(join(testRoot, "public"));
  copyFileSync(join(projectRoot, "tests/fixtures/one_page.pdf"), join(testRoot, "public/one_page.pdf"));
  writeFileSync(join(testRoot, "index.html"), '<div id="app"></div><script type="module" src="/main.ts"></script>');
  writeFileSync(
    join(testRoot, "main.ts"),
    `import { PdfDocument, mergePdfs, type PageInfo } from "pdfrs";\n\nconst page: PageInfo = { id: 1, pendingRotation: 0, markedForDeletion: false };\nvoid page;\nvoid mergePdfs;\n\nconst state = window as typeof window & { __pdfrsResult?: number | string };\ntry {\n  const response = await fetch("/one_page.pdf");\n  const document = await PdfDocument.open(new Uint8Array(await response.arrayBuffer()));\n  state.__pdfrsResult = document.getPageCount();\n} catch (error) {\n  state.__pdfrsResult = error instanceof Error ? error.message : String(error);\n}\n`,
  );
  writeFileSync(
    join(testRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM"],
          strict: true,
          noEmit: true,
        },
        include: ["main.ts"],
      },
      null,
      2,
    ),
  );

  run(pnpm, ["install"], testRoot);
  run(pnpm, ["exec", "tsc", "-p", "tsconfig.json"], testRoot);
  run(pnpm, ["exec", "vite", "build"], testRoot);

  const outputFiles = allFiles(join(testRoot, "dist"));
  const wasmFiles = outputFiles.filter((file) => file.endsWith(".wasm"));
  const workerFiles = outputFiles.filter((file) => file.includes("worker") && file.endsWith(".js"));
  if (wasmFiles.length !== 1) throw new Error(`Expected one self-contained full WASM asset, found: ${wasmFiles.join(", ")}`);
  if (workerFiles.length === 0) throw new Error("The consumer bundle does not contain the pdfrs worker");

  const port = 5300 + (process.pid % 500);
  const preview = spawn(pnpm, ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: testRoot,
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) break;
      } catch {
        // Vite is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const browserErrors = [];
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text());
      });
      page.on("pageerror", (error) => browserErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => "__pdfrsResult" in window);
      const result = await page.evaluate(() => window.__pdfrsResult);
      if (result !== 1) throw new Error(`Installed package runtime failed: ${String(result)}`);
      if (browserErrors.length > 0) throw new Error(`Browser errors: ${browserErrors.join("; ")}`);
    } finally {
      await browser.close();
    }
  } finally {
    preview.kill("SIGTERM");
  }

  console.log("\nPACKAGE_CONSUMER_OK");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
