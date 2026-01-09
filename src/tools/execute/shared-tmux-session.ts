import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { env } from "../../env";
import {
  formatBackgroundMessage,
  formatTerminalScreen,
  formatTimeoutMessage,
} from "./format-utils";
import { isInteractiveState } from "./interactive-detector";
import {
  buildEnvPrefix,
  wrapCommandNonInteractive,
} from "./noninteractive-wrapper";

const SESSION_PREFIX = "cea";
const DEFAULT_TIMEOUT_MS = 180_000;
const BACKGROUND_STARTUP_WAIT_MS = 3000;
const PANE_WIDTH = 160;
const PANE_HEIGHT = 40;

const ENTER_KEYS = new Set(["Enter", "C-m", "KPEnter", "C-j", "^M", "^J"]);
const NEWLINE_PATTERN = /[\r\n]$/;
const TRAILING_NEWLINES = /[\r\n]+$/;

let commandCounter = 0;
function generateCommandId(): string {
  const id = `${Date.now()}-${++commandCounter}`;
  return id;
}

export interface SendKeysOptions {
  block?: boolean;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
}

export interface ExecuteResult {
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

class SharedTmuxSession {
  private static instance: SharedTmuxSession | null = null;
  private readonly sessionId: string;
  private previousBuffer: string | null = null;
  private initialized = false;
  private destroyed = false;

  private constructor() {
    this.sessionId = process.env.CEA_SESSION_ID || generateSessionId();
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

  private execSync(command: string): SpawnSyncReturns<string> {
    return spawnSync("/bin/bash", ["-c", command], {
      encoding: "utf-8",
      env: { ...process.env, LANG: "en_US.UTF-8", TERM: "xterm-256color" },
    });
  }

  private execAsync(
    command: string,
    timeoutMs: number
  ): Promise<{ exitCode: number; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LANG: "en_US.UTF-8", TERM: "xterm-256color" },
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
      `tmux has-session -t ${this.sessionId} 2>/dev/null`
    );
    return result.status === 0;
  }

  private ensureSession(): void {
    if (this.destroyed) {
      throw new Error("Session has been destroyed and cannot be recreated");
    }

    if (this.initialized && this.isSessionAlive()) {
      return;
    }

    const startCommand = [
      "export TERM=xterm-256color",
      "export SHELL=/bin/bash",
      `tmux new-session -x ${PANE_WIDTH} -y ${PANE_HEIGHT} -d -s ${this.sessionId} 'bash --login'`,
      `tmux set-option -t ${this.sessionId} history-limit 50000`,
    ].join(" && ");

    const result = this.execSync(startCommand);
    if (result.status !== 0 && !this.isSessionAlive()) {
      throw new Error(`Failed to create tmux session: ${result.stderr}`);
    }

    this.execSync(`tmux send-keys -t ${this.sessionId} 'set +H' Enter`);

    this.initialized = true;
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
    prepared.push(`; tmux wait -S ${this.sessionId}`, "Enter");
    return { keys: prepared, isBlocking: true };
  }

  private buildSendKeysCommand(keys: string[]): string {
    const escapedKeys = keys.map(escapeShellArg).join(" ");
    return `tmux send-keys -t ${this.sessionId} ${escapedKeys}`;
  }

  private async sendBlockingKeys(
    keys: string[],
    maxTimeoutMs: number
  ): Promise<void> {
    const sendCommand = this.buildSendKeysCommand(keys);
    this.execSync(sendCommand);

    const waitResult = await this.execAsync(
      `tmux wait ${this.sessionId}`,
      maxTimeoutMs
    );

    if (waitResult.exitCode !== 0) {
      throw new Error(`Command timed out after ${maxTimeoutMs}ms`);
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
    const command = `tmux capture-pane -p ${extraArgs} -t ${this.sessionId}`;
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
    const errorMessage = [
      "[ERROR] Cannot execute command - terminal is in interactive state",
      "",
      `Current foreground process: ${result.currentProcess}`,
      "",
      "Use shell_interact to send keys to the interactive process.",
      "",
      "=== Current Terminal Screen ===",
      screen.trim(),
      "=== End of Screen ===",
    ].join("\n");

    return { isBlocking: true, message: errorMessage };
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

    await this.sendKeys([fullCommand, "Enter"], {
      block: false,
      minTimeoutMs: startupWaitMs,
    });

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

    const wrappedCommand = `echo ${startMarker}; ${fullCommand}; echo ${exitMarkerPrefix}$?__; tmux wait -S ${waitChannel}`;

    const sendCommand = this.buildSendKeysCommand([wrappedCommand, "Enter"]);
    this.execSync(sendCommand);

    const waitResult = await this.execAsync(
      `tmux wait ${waitChannel}`,
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

    const startIdx = rawOutput.lastIndexOf(startMarker);
    const exitIdx = rawOutput.lastIndexOf(exitMarkerPrefix);

    if (startIdx === -1 || exitIdx === -1) {
      return { exitCode: 0, output: rawOutput.trim() };
    }

    const exitPattern = new RegExp(`${exitMarkerPrefix}(\\d+)__`);
    const exitMatch = rawOutput.slice(exitIdx).match(exitPattern);
    const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : 0;
    const contentStart = startIdx + startMarker.length;
    const cleanOutput = rawOutput.slice(contentStart, exitIdx).trim();

    return { exitCode, output: cleanOutput };
  }

  async executeCommand(
    command: string,
    options: { workdir?: string; timeoutMs?: number } = {}
  ): Promise<ExecuteResult> {
    this.ensureSession();

    const interactiveCheck = this.checkInteractiveState();
    if (interactiveCheck.isBlocking) {
      return {
        exitCode: 1,
        output: interactiveCheck.message || "Terminal is in interactive state",
      };
    }

    const { workdir, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

    this.previousBuffer = this.capturePane(true);

    const wrapperResult = wrapCommandNonInteractive(command);
    const wrappedCommand = wrapperResult.wrapped
      ? `${buildEnvPrefix(wrapperResult.env)}${wrapperResult.command}`
      : command;

    let fullCommand = wrappedCommand;
    if (workdir) {
      fullCommand = `cd ${escapeShellArg(workdir)} && ${wrappedCommand}`;
    }

    if (this.endsWithBackgroundOperator(fullCommand)) {
      return await this.executeAsBackgroundProcess(fullCommand, timeoutMs);
    }

    return await this.executeWithUniqueMarkers(fullCommand, timeoutMs);
  }

  clearHistory(): void {
    if (!this.initialized) {
      return;
    }
    this.execSync(`tmux clear-history -t ${this.sessionId}`);
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
        const result = this.execSync(`tmux kill-session -t ${this.sessionId}`);
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

export const sharedSession = SharedTmuxSession.getInstance();

export function getSharedSession(): SharedTmuxSession {
  return SharedTmuxSession.getInstance();
}

export function cleanupSession(): void {
  SharedTmuxSession.resetInstance();
}
