import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
const READY_URL_PATTERN = /Ready on (https?:\/\/[^\s]+)/;
const READY_TIMEOUT_MS = 30_000;
const SMOKE_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 500;

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

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`fetch timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json();
    return { body, response };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForSmoke(url, child) {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
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
      const requestTimeoutMs = Math.max(
        1,
        Math.min(FETCH_TIMEOUT_MS, deadline - Date.now())
      );
      const { body, response } = await fetchJsonWithTimeout(
        url,
        requestTimeoutMs
      );
      if (response.ok && body.ok === true) {
        return body;
      }
      lastError = new Error(
        `unexpected response ${response.status}: ${JSON.stringify(body)}`
      );
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, POLL_INTERVAL_MS)
    );
  }

  throw lastError ?? new Error("timed out waiting for wrangler dev");
}

function startWranglerDev() {
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
      "0",
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

  let output = "";
  let settled = false;
  const readyUrl = new Promise((resolvePromise, reject) => {
    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      fn(value);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(READY_URL_PATTERN);
      if (match?.[1]) {
        settle(resolvePromise, match[1]);
      }
    };
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      onData(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      onData(chunk);
    });
    child.once("error", (error) => settle(reject, error));
    child.once("exit", (code, signal) => {
      settle(
        reject,
        new Error(
          `wrangler dev exited before readiness with code ${
            code ?? "null"
          } and signal ${signal ?? "null"}`
        )
      );
    });
  });

  return { child, readyUrl };
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

const { child, readyUrl } = startWranglerDev();

try {
  const url = await withTimeout(
    readyUrl,
    READY_TIMEOUT_MS,
    `timed out waiting ${READY_TIMEOUT_MS}ms for wrangler dev readiness`
  );
  const body = await waitForSmoke(url, child);
  console.log(`Cloudflare Worker edge smoke passed: ${body.sessionId}`);
} finally {
  await stopChild(child);
}
