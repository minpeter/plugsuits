import { spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { colorize } from "../interaction/colors";

const TOOLS_DIR = join(homedir(), ".cea", "bin");
const VERSION_PREFIX_REGEX = /^v/;
const ARCHIVE_EXTENSION_REGEX = /\.(tar\.gz|zip)$/;

interface ToolConfig {
  name: string;
  repo: string; // GitHub repo (e.g., "BurntSushi/ripgrep")
  binaryName: string; // Name of the binary inside the archive
  tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
  installable: boolean; // Can this tool be auto-installed?
  getAssetName: (
    version: string,
    plat: string,
    architecture: string
  ) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
  rg: {
    name: "ripgrep",
    repo: "BurntSushi/ripgrep",
    binaryName: "rg",
    tagPrefix: "",
    installable: true,
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
      }
      if (plat === "linux") {
        if (architecture === "arm64") {
          return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
        }
        return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
      }
      if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
  tmux: {
    name: "tmux",
    repo: "", // tmux doesn't have simple GitHub releases
    binaryName: "tmux",
    tagPrefix: "",
    installable: false, // Must be installed via system package manager
    getAssetName: () => null,
  },
};

/**
 * Check if a command exists and is executable
 */
function commandExists(cmd: string): boolean {
  const plat = platform();
  const whichCmd = plat === "win32" ? "where" : "which";
  try {
    const result = spawnSync(whichCmd, [cmd], {
      stdio: "pipe",
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Get the path to a tool (system-wide or in our tools dir)
 */
export function getToolPath(tool: "rg" | "tmux"): string | null {
  const config = TOOLS[tool];
  if (!config) {
    return null;
  }

  // Check our tools directory first
  const localPath = join(
    TOOLS_DIR,
    config.binaryName + (platform() === "win32" ? ".exe" : "")
  );
  if (existsSync(localPath)) {
    return localPath;
  }

  // Check system PATH - if found, just return the command name (it's in PATH)
  if (commandExists(config.binaryName)) {
    return config.binaryName;
  }

  return null;
}

/**
 * Fetch latest release version from GitHub
 */
async function getLatestVersion(repo: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: { "User-Agent": "code-editing-agent" },
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = (await response.json()) as { tag_name: string };
  return data.tag_name.replace(VERSION_PREFIX_REGEX, "");
}

/**
 * Download a file from URL
 */
async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const fileStream = createWriteStream(dest);
  // Type assertion needed because fetch's ReadableStream is from web API
  // @ts-expect-error - Type mismatch between web ReadableStream and node stream/web ReadableStream
  await finished(Readable.fromWeb(response.body).pipe(fileStream));
}

/**
 * Download and install a tool from GitHub releases
 */
async function downloadTool(tool: "rg"): Promise<string> {
  const config = TOOLS[tool];
  if (!config) {
    throw new Error(`Unknown tool: ${tool}`);
  }
  if (!config.installable) {
    throw new Error(`Tool ${config.name} cannot be auto-installed`);
  }

  const plat = platform();
  const architecture = arch();

  // Get latest version
  const version = await getLatestVersion(config.repo);

  // Get asset name for this platform
  const assetName = config.getAssetName(version, plat, architecture);
  if (!assetName) {
    throw new Error(`Unsupported platform: ${plat}/${architecture}`);
  }

  // Create tools directory
  mkdirSync(TOOLS_DIR, { recursive: true });

  const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
  const archivePath = join(TOOLS_DIR, assetName);
  const binaryExt = plat === "win32" ? ".exe" : "";
  const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

  // Download
  await downloadFile(downloadUrl, archivePath);

  // Extract
  const extractDir = join(TOOLS_DIR, "extract_tmp");
  mkdirSync(extractDir, { recursive: true });

  try {
    if (assetName.endsWith(".tar.gz")) {
      spawnSync("tar", ["xzf", archivePath, "-C", extractDir], {
        stdio: "pipe",
      });
    } else if (assetName.endsWith(".zip")) {
      spawnSync("unzip", ["-o", archivePath, "-d", extractDir], {
        stdio: "pipe",
      });
    }

    // Find the binary in extracted files
    const extractedDir = join(
      extractDir,
      assetName.replace(ARCHIVE_EXTENSION_REGEX, "")
    );
    const extractedBinary = join(extractedDir, config.binaryName + binaryExt);

    if (existsSync(extractedBinary)) {
      renameSync(extractedBinary, binaryPath);
    } else {
      throw new Error(`Binary not found in archive: ${extractedBinary}`);
    }

    // Make executable (Unix only)
    if (plat !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    // Cleanup
    rmSync(archivePath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }

  return binaryPath;
}

/**
 * Show installation instructions for a non-installable tool
 */
function showInstallInstructions(config: ToolConfig, silent: boolean): void {
  if (silent) {
    return;
  }

  console.error(
    colorize(
      "yellow",
      `${config.name} is not installed. Please install it using your system package manager:`
    )
  );

  const plat = platform();
  if (plat === "darwin") {
    console.error(colorize("dim", `  brew install ${config.name}`));
  } else if (plat === "linux") {
    console.error(
      colorize("dim", `  apt install ${config.name}  # Debian/Ubuntu`)
    );
    console.error(
      colorize("dim", `  yum install ${config.name}  # RHEL/CentOS`)
    );
  } else if (plat === "win32") {
    console.error(
      colorize("dim", `  choco install ${config.name}  # Chocolatey`)
    );
  }
}

/**
 * Attempt to download and install a tool
 */
async function attemptToolDownload(
  tool: "rg",
  config: ToolConfig,
  silent: boolean
): Promise<string | undefined> {
  if (!silent) {
    console.error(colorize("dim", `${config.name} not found. Downloading...`));
  }

  try {
    const path = await downloadTool(tool);
    if (!silent) {
      console.error(colorize("dim", `${config.name} installed to ${path}`));
    }
    return path;
  } catch (e) {
    if (!silent) {
      console.error(
        colorize(
          "yellow",
          `Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`
        )
      );
    }
    return undefined;
  }
}

/**
 * Ensure a tool is available, downloading if necessary
 * Returns the path to the tool, or null if unavailable
 */
export async function ensureTool(
  tool: "rg" | "tmux",
  silent = false
): Promise<string | undefined> {
  const existingPath = getToolPath(tool);
  if (existingPath) {
    return existingPath;
  }

  const config = TOOLS[tool];
  if (!config) {
    return undefined;
  }

  // For non-installable tools, show installation instructions
  if (!config.installable) {
    showInstallInstructions(config, silent);
    return undefined;
  }

  // Tool not found - download it
  return await attemptToolDownload(tool as "rg", config, silent);
}

/**
 * Initialize tools on startup
 * Checks for required tools and downloads/reports missing ones
 * Throws an error if any required tool is unavailable
 */
export async function initializeTools(): Promise<void> {
  const tools: Array<"rg" | "tmux"> = ["rg", "tmux"];
  const results = await Promise.allSettled(
    tools.map((tool) => ensureTool(tool, false))
  );

  const missingTools: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const tool = tools[i];

    if (result.status === "fulfilled" && result.value === undefined) {
      missingTools.push(tool);
    }
  }

  if (missingTools.length > 0) {
    console.error("");
    console.error(
      colorize(
        "red",
        "ERROR: Required tools are missing and could not be installed automatically."
      )
    );
    console.error("");
    console.error(
      colorize("dim", "The following tools are required for this CLI to work:")
    );
    for (const tool of missingTools) {
      console.error(colorize("yellow", `  - ${tool}`));
    }
    console.error("");
    console.error(
      colorize("dim", "Please install the missing tools and try again.")
    );
    console.error("");
    process.exit(1);
  }
}
