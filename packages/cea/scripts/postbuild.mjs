import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(packageDir, "dist");
const srcDir = resolve(packageDir, "src");

async function copyTextAssets(relativeDir) {
  const sourceDir = resolve(srcDir, relativeDir);
  const targetDir = resolve(distDir, relativeDir);
  await mkdir(targetDir, { recursive: true });

  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== ".txt") {
      continue;
    }

    await cp(resolve(sourceDir, entry.name), resolve(targetDir, entry.name), {
      force: true,
    });
  }
}

for (const relativeDir of [
  "tools/execute",
  "tools/explore",
  "tools/modify",
  "tools/planning",
]) {
  await copyTextAssets(relativeDir);
}

await rm(resolve(distDir, "skills"), { force: true, recursive: true });
await cp(resolve(srcDir, "skills"), resolve(distDir, "skills"), {
  recursive: true,
  force: true,
});
