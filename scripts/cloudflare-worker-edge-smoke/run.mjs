import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const WRANGLER_CONFIG = join(
  ROOT,
  "packages/harness/edge-smoke/wrangler.jsonc"
);
const WRANGLER_ENV = {
  ...process.env,
  FORCE_COLOR: "0",
  WRANGLER_LOG_PATH: join(tmpdir(), "plugsuits-wrangler-logs"),
  WRANGLER_SEND_METRICS: "false",
};
const WORK_DIR = mkdtempSync(join(tmpdir(), "plugsuits-worker-edge-"));

function runWrangler(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: WRANGLER_ENV,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed`);
  }
}

async function getPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (typeof address !== "object" || address === null) {
    throw new Error("failed to allocate local port");
  }
  return address.port;
}

async function waitForSmoke(url, child) {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `wrangler dev exited with code ${child.exitCode ?? "null"} and signal ${
          child.signalCode ?? "null"
        }`
      );
    }

    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.ok && body.ok === true) {
        return body;
      }
      lastError = new Error(
        `unexpected response ${response.status}: ${JSON.stringify(body)}`
      );
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  throw lastError ?? new Error("timed out waiting for wrangler dev");
}

function startWranglerDev(port) {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      WRANGLER_CONFIG,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--local",
      "--persist-to",
      join(WORK_DIR, "state"),
    ],
    {
      cwd: ROOT,
      env: WRANGLER_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

runWrangler([
  "deploy",
  "--dry-run",
  "--outdir",
  join(WORK_DIR, "dry-run"),
  "--config",
  WRANGLER_CONFIG,
]);

const port = await getPort();
const child = startWranglerDev(port);

try {
  const body = await waitForSmoke(`http://127.0.0.1:${port}/`, child);
  console.log(`Cloudflare Worker edge smoke passed: ${body.sessionId}`);
} finally {
  await stopChild(child);
}
