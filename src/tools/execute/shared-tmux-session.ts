import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { env } from "../../env";
import { getToolPath } from "../../utils/tools-manager";
import {
  formatBackgroundMessage,
  formatTerminalScreen,
  formatTimeoutMessage,
  stripInternalMarkers,
} from "./format-utils";
import { isInteractiveState } from "./interactive-detector";
import {
  buildEnvPrefix,
  wrapCommandNonInteractive,
} from "./noninteractive-wrapper";

const SESSION_PREFIX = "cea";
const OWNER_PID_ENV_KEY = "CEA_OWNER_PID";
const DEFAULT_TIMEOUT_MS = 180_000;
const BACKGROUND_STARTUP_WAIT_MS = 3000;
const SHELL_READY_POLL_MS = 100;
const SHELL_READY_TIMEOUT_MS = 5000;
const PANE_WIDTH = 160;
const PANE_HEIGHT = 40;

const ENTER_KEYS = new Set(["Enter", "C-m", "KPEnter", "C-j", "^M", "^J"]);
const NEWLINE_PATTERN = /[\r\n]$/;
const TRAILING_NEWLINES = /[\r\n]+$/;
const PROMPT_LINE_PATTERN = /[$#%]\s*$/;
const COMPOUND_COMMAND_PATTERN =
  /^\s*(\(|\{|if\b|for\b|while\b|until\b|case\b|select\b|function\b|\[\[)/;

let commandCounter = 0;
function generateCommandId(): string {
  const id = `${Date.now()}-${++commandCounter}`;
  return id;
}

interface SendKeysOptions {
  block?: boolean;
  maxTimeoutMs?: number;
  minTimeoutMs?: number;
}

interface ExecuteResult {
  exitCode: number;
  output: string;
}

function generateSessionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${SESSION_PREFIX}-${timestamp}-${random}`;
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function startsWithCompoundCommand(command: string): boolean {
  return COMPOUND_COMMAND_PATTERN.test(command);
}

function normalizeMultilineCommand(command: string): string {
  const normalizedLineEndings = command.replace(/\r\n/g, "\n");

  if (
    !(
      normalizedLineEndings.includes("\n") ||
      normalizedLineEndings.includes("\r")
    )
  ) {
    return command;
  }

  const escaped = normalizedLineEndings
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\\''")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");

  return `eval "$(printf '%b' '${escaped}')"`;
}

class SharedTmuxSession {
  private static instance: SharedTmuxSession | null = null;
  private readonly sessionId: string;
  private readonly tmuxPath: string;
  private previousBuffer: string | null = null;
  private initialized = false;
  private destroyed = false;
  private commandQueue: Promise<void> = Promise.resolve();
  private staleCleanupChecked = false;

  private constructor() {
    this.sessionId = process.env.CEA_SESSION_ID || generateSessionId();
    const tmux = getToolPath("tmux");
    if (!tmux) {
      throw new Error(
        "tmux is not installed. Please install it using your system package manager."
      );
    }
    this.tmuxPath = tmux;
  }

  static getInstance(): SharedTmuxSession {
    if (!SharedTmuxSession.instance) {
      SharedTmuxSession.instance = new SharedTmuxSession();
    }
    return SharedTmuxSession.instance;
  }

  static resetInstance(): void {
    if (env.DEBUG_TMUX_CLEANUP && SharedTmuxSession.instance) {
      console.error(
        `[DEBUG] resetInstance called. Instance exists: true, sessionId: ${SharedTmuxSession.instance.sessionId}`
      );
    }
    if (SharedTmuxSession.instance) {
      SharedTmuxSession.instance.cleanup();
    }
    SharedTmuxSession.instance = null;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private getCleanEnv(): Record<string, string> {
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        !key.startsWith("npm_") &&
        key !== "NODE_ENV" &&
        value !== undefined
      ) {
        cleanEnv[key] = value;
      }
    }

    cleanEnv.LANG = "en_US.UTF-8";
    cleanEnv.TERM = "xterm-256color";
    return cleanEnv;
  }

  private execSync(command: string): SpawnSyncReturns<string> {
    return spawnSync("/bin/bash", ["-c", command], {
      encoding: "utf-8",
      env: this.getCleanEnv(),
    });
  }

  private execTmuxCommand(
    args: string[],
    options: { input?: string } = {}
  ): SpawnSyncReturns<string> {
    return spawnSync(this.tmuxPath, args, {
      encoding: "utf-8",
      env: this.getCleanEnv(),
      input: options.input,
    });
  }

  private isProcessAlive(pid: number): boolean {
    if (pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but we lack permission to signal it
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return true;
      }
      return false;
    }
  }

  private parseOwnerPid(value: string): number | null {
    const trimmed = value.trim();
    const prefix = `${OWNER_PID_ENV_KEY}=`;

    if (!trimmed.startsWith(prefix)) {
      return null;
    }

    const parsed = Number.parseInt(trimmed.slice(prefix.length), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return parsed;
  }

  private getSessionOwnerPid(sessionName: string): number | null {
    const result = this.execTmuxCommand([
      "show-environment",
      "-t",
      sessionName,
      OWNER_PID_ENV_KEY,
    ]);

    if (result.status !== 0) {
      return null;
    }

    return this.parseOwnerPid(result.stdout || "");
  }

  private cleanupStaleOwnedSessions(): void {
    if (this.staleCleanupChecked) {
      return;
    }
    this.staleCleanupChecked = true;

    const listResult = this.execTmuxCommand([
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    if (listResult.status !== 0) {
      return;
    }

    const sessions = (listResult.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => line.startsWith(`${SESSION_PREFIX}-`))
      .filter((line) => line !== this.sessionId);

    for (const sessionName of sessions) {
      const ownerPid = this.getSessionOwnerPid(sessionName);
      if (!ownerPid || this.isProcessAlive(ownerPid)) {
        continue;
      }

      this.execTmuxCommand(["kill-session", "-t", sessionName]);
    }
  }

  private markSessionOwnership(): void {
    this.execTmuxCommand([
      "set-environment",
      "-t",
      this.sessionId,
      OWNER_PID_ENV_KEY,
      String(process.pid),
    ]);
  }

  private execAsync(
    command: string,
    timeoutMs: number
  ): Promise<{ exitCode: number; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: this.getCleanEnv(),
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          resolve({ exitCode: 124, stdout: "Command timed out" });
        } else {
          resolve({ exitCode: code ?? 0, stdout: stdout || stderr });
        }
      });

      child.on("error", () => {
        clearTimeout(timeout);
        resolve({ exitCode: -1, stdout: "Failed to spawn process" });
      });
    });
  }

  isSessionAlive(): boolean {
    const result = this.execSync(
      `${this.tmuxPath} has-session -t ${this.sessionId} 2>/dev/null`
    );
    return result.status === 0;
  }

  private ensureSession(): void {
    if (this.destroyed) {
      throw new Error(
        "Terminal session has been destroyed. " +
          "This is an internal error - the session should auto-recover. " +
          "Try the command again."
      );
    }

    if (this.initialized && this.isSessionAlive()) {
      return;
    }

    this.cleanupStaleOwnedSessions();

    const startCommand = [
      "export TERM=xterm-256color",
      "export SHELL=/bin/bash",
      // Clean npm environment variables to avoid shell errors
      "unset $(env | grep '^npm_' | cut -d= -f1)",
      `${this.tmuxPath} new-session -x ${PANE_WIDTH} -y ${PANE_HEIGHT} -d -s ${this.sessionId} 'bash +H'`,
      `${this.tmuxPath} set-option -t ${this.sessionId} history-limit 50000`,
    ].join(" && ");

    const result = this.execSync(startCommand);
    if (result.status !== 0 && !this.isSessionAlive()) {
      throw new Error(`Failed to create tmux session: ${result.stderr}`);
    }

    this.markSessionOwnership();

    this.execSync(
      `${this.tmuxPath} send-keys -t ${this.sessionId} 'set +H' Enter`
    );
    this.waitForPrompt();

    this.initialized = true;
  }

  private getLastNonEmptyPaneLine(): string {
    const capture = this.execSync(
      `${this.tmuxPath} capture-pane -p -t ${this.sessionId}`
    );
    const lines = (capture.stdout || "").split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.length > 0) {
        return line;
      }
    }

    return "";
  }

  private waitForPrompt(): void {
    const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const lastLine = this.getLastNonEmptyPaneLine();
      if (PROMPT_LINE_PATTERN.test(lastLine)) {
        return;
      }

      this.execSync(`sleep ${SHELL_READY_POLL_MS / 1000}`);
    }

    throw new Error(
      `Shell prompt not detected within ${SHELL_READY_TIMEOUT_MS}ms`
    );
  }

  private isEnterKey(key: string): boolean {
    return ENTER_KEYS.has(key);
  }

  private endsWithNewline(key: string): boolean {
    return NEWLINE_PATTERN.test(key);
  }

  private isExecutingCommand(key: string): boolean {
    return this.isEnterKey(key) || this.endsWithNewline(key);
  }

  private preventExecution(keys: string[]): string[] {
    const result = [...keys];
    let lastKey = result.at(-1);
    while (result.length > 0 && lastKey && this.isExecutingCommand(lastKey)) {
      if (this.isEnterKey(lastKey)) {
        result.pop();
      } else {
        const stripped = lastKey.replace(TRAILING_NEWLINES, "");
        if (stripped) {
          result[result.length - 1] = stripped;
        } else {
          result.pop();
        }
      }
      lastKey = result.at(-1);
    }
    return result;
  }

  private prepareKeys(
    keys: string[],
    block: boolean
  ): { keys: string[]; isBlocking: boolean } {
    const lastKey = keys.at(-1);
    if (!(block && lastKey && this.isExecutingCommand(lastKey))) {
      return { keys, isBlocking: false };
    }

    const prepared = this.preventExecution(keys);
    prepared.push(`; ${this.tmuxPath} wait -S ${this.sessionId}`, "Enter");
    return { keys: prepared, isBlocking: true };
  }

  private buildSendKeysCommand(keys: string[]): string {
    const escapedKeys = keys.map(escapeShellArg).join(" ");
    return `${this.tmuxPath} send-keys -t ${this.sessionId} ${escapedKeys}`;
  }

  private sendCommandText(text: string): void {
    const bufferName = `cea-buffer-${generateCommandId()}`;
    const loadResult = this.execTmuxCommand(
      ["load-buffer", "-b", bufferName, "-"],
      { input: text }
    );
    if (loadResult.status !== 0) {
      throw new Error(`Failed to load tmux buffer: ${loadResult.stderr}`);
    }

    const pasteResult = this.execTmuxCommand([
      "paste-buffer",
      "-d",
      "-b",
      bufferName,
      "-t",
      this.sessionId,
    ]);

    if (pasteResult.status !== 0) {
      throw new Error(`Failed to paste tmux buffer: ${pasteResult.stderr}`);
    }
  }

  private async disableHistoryExpansion(): Promise<void> {
    const waitChannel = `${this.sessionId}-histexp-${generateCommandId()}`;
    const command = `set +H; ${this.tmuxPath} wait -S ${waitChannel}`;

    this.execSync(this.buildSendKeysCommand(["C-u"]));
    this.sendCommandText(command);
    this.execSync(this.buildSendKeysCommand(["Enter"]));

    await this.execAsync(`${this.tmuxPath} wait ${waitChannel}`, 2000);
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.commandQueue.then(task, task);
    this.commandQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async sendBlockingKeys(
    keys: string[],
    maxTimeoutMs: number
  ): Promise<void> {
    const sendCommand = this.buildSendKeysCommand(keys);
    this.execSync(sendCommand);

    const waitResult = await this.execAsync(
      `${this.tmuxPath} wait ${this.sessionId}`,
      maxTimeoutMs
    );

    if (waitResult.exitCode !== 0) {
      throw new Error(
        `Command timed out after ${maxTimeoutMs}ms. ` +
          "The process may still be running. " +
          "Use shell_interact to check output or send <Ctrl+C> to interrupt."
      );
    }
  }

  private async sendNonBlockingKeys(
    keys: string[],
    minTimeoutMs: number
  ): Promise<void> {
    const startTime = Date.now();
    const sendCommand = this.buildSendKeysCommand(keys);
    this.execSync(sendCommand);

    const elapsed = Date.now() - startTime;
    if (elapsed < minTimeoutMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, minTimeoutMs - elapsed)
      );
    }
  }

  async sendKeys(
    keys: string | string[],
    options: SendKeysOptions = {}
  ): Promise<string> {
    this.ensureSession();

    const {
      block = false,
      minTimeoutMs = 100,
      maxTimeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;
    const keyList = Array.isArray(keys) ? keys : [keys];

    const { keys: prepared, isBlocking } = this.prepareKeys(keyList, block);

    if (isBlocking) {
      await this.sendBlockingKeys(prepared, maxTimeoutMs);
    } else {
      await this.sendNonBlockingKeys(prepared, minTimeoutMs);
    }

    return this.capturePane();
  }

  capturePane(captureEntire = false): string {
    this.ensureSession();

    const extraArgs = captureEntire ? "-S -" : "";
    const command = `${this.tmuxPath} capture-pane -p ${extraArgs} -t ${this.sessionId}`;
    const result = this.execSync(command);
    return result.stdout || "";
  }

  private getVisibleScreen(): string {
    return this.capturePane(false);
  }

  private findNewContent(currentBuffer: string): string | null {
    if (this.previousBuffer === null) {
      return null;
    }

    const pb = this.previousBuffer.trim();
    if (currentBuffer.includes(pb)) {
      const idx = currentBuffer.indexOf(pb);
      const newlineIdx = pb.lastIndexOf("\n");
      const startIdx = newlineIdx >= 0 ? idx + newlineIdx : idx + pb.length;
      return currentBuffer.slice(startIdx);
    }

    return null;
  }

  getIncrementalOutput(): string {
    const currentBuffer = this.capturePane(true);

    if (this.previousBuffer === null) {
      this.previousBuffer = currentBuffer;
      return formatTerminalScreen(this.getVisibleScreen());
    }

    const newContent = this.findNewContent(currentBuffer);
    this.previousBuffer = currentBuffer;

    if (newContent !== null) {
      const trimmed = newContent.trim();
      if (trimmed) {
        return formatTerminalScreen(trimmed);
      }
      return formatTerminalScreen(this.getVisibleScreen());
    }

    return formatTerminalScreen(this.getVisibleScreen());
  }

  checkInteractiveState(): { isBlocking: boolean; message: string | null } {
    if (!(this.initialized && this.isSessionAlive())) {
      return { isBlocking: false, message: null };
    }

    const result = isInteractiveState(this.sessionId);

    if (!result.isInteractive) {
      return { isBlocking: false, message: null };
    }

    const screen = this.capturePane(false);
    const reasonDetail = this.formatInteractiveReason(result.reason);
    const processInfo = result.currentProcess
      ? `Current foreground process: ${result.currentProcess}`
      : "Unable to determine foreground process";

    const errorMessage = [
      "[ERROR] Cannot execute command - terminal is in interactive state",
      "",
      processInfo,
      reasonDetail,
      "",
      "Use shell_interact to send keys to the interactive process.",
      "",
      "=== Current Terminal Screen ===",
      screen.trim(),
      "=== End of Screen ===",
    ].join("\n");

    return { isBlocking: true, message: errorMessage };
  }

  private formatInteractiveReason(reason?: string): string {
    switch (reason) {
      case "tmux_query_failed":
        return "Reason: Unable to query terminal state";
      case "pane_dead":
        return "Reason: Terminal pane has exited";
      case "pane_in_mode":
        return "Reason: Terminal is in copy/scroll mode";
      default:
        return "";
    }
  }

  private endsWithBackgroundOperator(command: string): boolean {
    const trimmed = command.trim();
    const endsWithAmpersand = trimmed.endsWith("&");
    const isLogicalAnd = trimmed.endsWith("&&");
    return endsWithAmpersand && !isLogicalAnd;
  }

  private async executeAsBackgroundProcess(
    fullCommand: string,
    timeoutMs: number
  ): Promise<ExecuteResult> {
    const startupWaitMs = Math.min(timeoutMs, BACKGROUND_STARTUP_WAIT_MS);

    await this.disableHistoryExpansion();

    const startedAt = Date.now();
    this.execSync(this.buildSendKeysCommand(["C-u"]));
    this.sendCommandText(fullCommand);
    this.execSync(this.buildSendKeysCommand(["Enter"]));

    const elapsed = Date.now() - startedAt;
    if (elapsed < startupWaitMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, startupWaitMs - elapsed)
      );
    }

    const screen = this.capturePane(false);
    return {
      exitCode: 0,
      output: formatBackgroundMessage(screen),
    };
  }

  private async executeWithUniqueMarkers(
    fullCommand: string,
    timeoutMs: number
  ): Promise<ExecuteResult> {
    const cmdId = generateCommandId();
    const startMarker = `__CEA_S_${cmdId}__`;
    const exitMarkerPrefix = `__CEA_E_${cmdId}_`;
    const waitChannel = `${this.sessionId}-${cmdId}`;

    await this.disableHistoryExpansion();

    const wrappedCommand = [
      `echo ${startMarker};`,
      `( trap 'echo ${exitMarkerPrefix}$?__' EXIT; ${fullCommand}; ) || true;`,
      `${this.tmuxPath} wait -S ${waitChannel}`,
    ].join(" ");

    this.execSync(this.buildSendKeysCommand(["C-u"]));
    this.sendCommandText(wrappedCommand);
    this.execSync(this.buildSendKeysCommand(["Enter"]));

    const waitResult = await this.execAsync(
      `${this.tmuxPath} wait ${waitChannel}`,
      timeoutMs
    );

    if (waitResult.exitCode !== 0) {
      const interactiveResult = isInteractiveState(this.sessionId);

      if (interactiveResult.isInteractive) {
        const currentScreen = this.capturePane(false);
        return {
          exitCode: 1,
          output: [
            "[ERROR] Command blocked - terminal entered interactive state",
            "",
            `Current foreground process: ${interactiveResult.currentProcess}`,
            "",
            "Use shell_interact to send keys to the interactive process.",
            "",
            "=== Current Terminal Screen ===",
            currentScreen.trim(),
            "=== End of Screen ===",
          ].join("\n"),
        };
      }

      const currentScreen = this.capturePane(false);
      return {
        exitCode: 124,
        output: formatTimeoutMessage({
          timeoutMs,
          terminalScreen: currentScreen,
          sessionId: this.sessionId,
        }),
      };
    }

    const rawOutput = this.capturePane(true);
    const startToken = `${startMarker}\n`;
    const startTokenIndex = rawOutput.lastIndexOf(startToken);
    const startIndex =
      startTokenIndex === -1
        ? rawOutput.lastIndexOf(startMarker)
        : startTokenIndex;
    const startMarkerLength =
      startTokenIndex === -1 ? startMarker.length : startToken.length;

    const exitMatches = Array.from(
      rawOutput.matchAll(
        new RegExp(`${exitMarkerPrefix}(\\d+)__(?:\\r?\\n|$)`, "g")
      )
    );
    const lastExitMatch = exitMatches.at(-1);
    const exitIndex = lastExitMatch?.index ?? -1;
    const exitCode = lastExitMatch ? Number.parseInt(lastExitMatch[1], 10) : 0;

    const hasInvalidMarkerOrder = startIndex !== -1 && exitIndex <= startIndex;

    if (exitIndex === -1 || hasInvalidMarkerOrder) {
      const currentScreen = this.capturePane(false);
      return {
        exitCode: 1,
        output: [
          "[ERROR] Internal output capture failed - marker boundaries not found.",
          "",
          "Command may still be running in the terminal session.",
          "Use shell_interact with '<Ctrl+C>' to recover if needed.",
          "",
          formatTerminalScreen(currentScreen),
        ].join("\n"),
      };
    }

    const contentStart = startIndex === -1 ? 0 : startIndex + startMarkerLength;
    const cleanOutput = stripInternalMarkers(
      rawOutput.slice(contentStart, exitIndex)
    );

    return { exitCode, output: cleanOutput };
  }

  async executeCommand(
    command: string,
    options: { workdir?: string; timeoutMs?: number } = {}
  ): Promise<ExecuteResult> {
    return await this.runExclusive(async () => {
      this.ensureSession();

      const interactiveCheck = this.checkInteractiveState();
      if (interactiveCheck.isBlocking) {
        return {
          exitCode: 1,
          output:
            interactiveCheck.message || "Terminal is in interactive state",
        };
      }

      const { workdir, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

      this.previousBuffer = this.capturePane(true);

      const wrapperResult = wrapCommandNonInteractive(command);
      let wrappedCommand = command;
      if (wrapperResult.wrapped) {
        const envPrefix = buildEnvPrefix(wrapperResult.env);
        if (startsWithCompoundCommand(wrapperResult.command)) {
          wrappedCommand = `${envPrefix}bash -lc ${escapeShellArg(
            wrapperResult.command
          )}`;
        } else {
          wrappedCommand = `${envPrefix}${wrapperResult.command}`;
        }
      }

      let fullCommand = wrappedCommand;
      if (workdir) {
        fullCommand = `cd ${escapeShellArg(workdir)} && ${wrappedCommand}`;
      }

      const normalizedCommand = normalizeMultilineCommand(fullCommand);

      if (this.endsWithBackgroundOperator(normalizedCommand)) {
        return await this.executeAsBackgroundProcess(
          normalizedCommand,
          timeoutMs
        );
      }

      return await this.executeWithUniqueMarkers(normalizedCommand, timeoutMs);
    });
  }

  clearHistory(): void {
    if (!this.initialized) {
      return;
    }
    this.execSync(`${this.tmuxPath} clear-history -t ${this.sessionId}`);
    this.previousBuffer = null;
  }

  cleanup(): void {
    if (this.destroyed) {
      return;
    }

    if (env.DEBUG_TMUX_CLEANUP) {
      console.error(
        `[DEBUG] cleanup() called for session: ${this.sessionId}, initialized: ${this.initialized}`
      );
    }

    try {
      const isAlive = this.isSessionAlive();
      if (env.DEBUG_TMUX_CLEANUP) {
        console.error(`[DEBUG] Session ${this.sessionId} alive: ${isAlive}`);
      }

      if (isAlive) {
        if (env.DEBUG_TMUX_CLEANUP) {
          console.error(`[DEBUG] Killing tmux session: ${this.sessionId}`);
        }
        const result = this.execSync(
          `${this.tmuxPath} kill-session -t ${this.sessionId}`
        );
        if (result.status !== 0) {
          console.error(
            `Warning: Failed to kill tmux session ${this.sessionId}: ${result.stderr}`
          );
        } else if (env.DEBUG_TMUX_CLEANUP) {
          console.error(`[DEBUG] Cleaned up tmux session: ${this.sessionId}`);
        }
      } else if (env.DEBUG_TMUX_CLEANUP) {
        console.error(
          `[DEBUG] Session ${this.sessionId} already dead, skipping kill`
        );
      }
    } catch (error) {
      console.error(`Error during tmux session cleanup: ${error}`);
    } finally {
      this.initialized = false;
      this.previousBuffer = null;
      this.destroyed = true;
    }
  }
}

export function getSharedSession(): SharedTmuxSession {
  return SharedTmuxSession.getInstance();
}

export function cleanupSession(): void {
  SharedTmuxSession.resetInstance();
}
