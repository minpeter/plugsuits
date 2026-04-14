import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MessageLine, SessionFileLine } from "./compaction-types";
import type { HistorySnapshot } from "./history-snapshot";

export interface SessionData {
  historySnapshot?: HistorySnapshot;
  messages: MessageLine[];
  sessionId: string;
  summaryMessageId: string | null;
}

/**
 * Encodes a session ID into a filesystem-safe JSONL basename.
 *
 * The encoding preserves ASCII letters, digits, and `-` as-is, and escapes every
 * other BMP character as `_xxxx` using lowercase 4-digit hex. `_` is itself
 * escaped, so the mapping stays injective and can be losslessly reversed by
 * {@link decodeSessionId}.
 */
export function encodeSessionId(sessionId: string): string {
  if (sessionId.length === 0) {
    throw new Error("sessionId must not be empty");
  }
  return sessionId.replace(/[^A-Za-z0-9-]/g, (ch) => {
    return `_${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function decodeSessionId(encodedSessionId: string): string {
  if (encodedSessionId.length === 0) {
    throw new Error("encodedSessionId must not be empty");
  }

  return encodedSessionId.replace(/_([0-9a-f]{4})/g, (_match, hex: string) => {
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}

/**
 * @deprecated Use {@link FileSnapshotStore} instead for a cleaner persistence abstraction.
 * SessionStore will be removed in the next major release.
 */
export class SessionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private getFilePath(sessionId: string): string {
    const encoded = encodeSessionId(sessionId);
    const primary = join(this.baseDir, `${encoded}.jsonl`);
    if (existsSync(primary)) {
      return primary;
    }
    const legacy = join(this.baseDir, `${sessionId}.jsonl`);
    if (existsSync(legacy)) {
      return legacy;
    }
    return primary;
  }

  private ensureHeader(sessionId: string): void {
    const filePath = this.getFilePath(sessionId);

    if (existsSync(filePath)) {
      return;
    }

    const header: SessionFileLine = {
      type: "header",
      sessionId,
      createdAt: Date.now(),
      version: 1,
    };

    appendFileSync(filePath, `${JSON.stringify(header)}\n`, "utf8");
  }

  appendMessage(sessionId: string, line: MessageLine): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    this.ensureHeader(sessionId);
    appendFileSync(filePath, `${JSON.stringify(line)}\n`, "utf8");
    return Promise.resolve();
  }

  updateCheckpoint(sessionId: string, summaryMessageId: string): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    this.ensureHeader(sessionId);

    const checkpoint: SessionFileLine = {
      type: "checkpoint",
      summaryMessageId,
      updatedAt: Date.now(),
    };

    appendFileSync(filePath, `${JSON.stringify(checkpoint)}\n`, "utf8");
    return Promise.resolve();
  }

  replaceSessionSnapshot(
    sessionId: string,
    snapshot: HistorySnapshot
  ): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    const tempFilePath = `${filePath}.${randomUUID()}.tmp`;
    const lines: SessionFileLine[] = [
      {
        type: "header",
        sessionId,
        createdAt: Date.now(),
        version: 1,
      },
      {
        type: "snapshot",
        snapshot,
        updatedAt: Date.now(),
      },
      ...snapshot.messages.map(
        (message): SessionFileLine => ({
          type: "message",
          id: message.id,
          message: message.message,
          createdAt: message.createdAt ?? Date.now(),
          isSummary: message.isSummary ?? false,
          originalContent: message.originalContent,
        })
      ),
    ];

    const summaryMessageId = snapshot.compactionState?.summaryMessageId;
    if (summaryMessageId) {
      lines.push({
        type: "checkpoint",
        summaryMessageId,
        updatedAt: Date.now(),
      });
    }

    writeFileSync(
      tempFilePath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8"
    );
    renameSync(tempFilePath, filePath);
    return Promise.resolve();
  }

  loadSession(sessionId: string): Promise<SessionData | null> {
    const filePath = this.getFilePath(sessionId);

    if (!existsSync(filePath)) {
      return Promise.resolve(null);
    }

    const content = readFileSync(filePath, "utf8");
    const rawLines = content.split("\n");
    const messages: MessageLine[] = [];
    let historySnapshot: HistorySnapshot | undefined;
    let summaryMessageId: string | null = null;

    for (const rawLine of rawLines) {
      if (rawLine.trim().length === 0) {
        continue;
      }

      try {
        const line = JSON.parse(rawLine) as SessionFileLine;

        if (line.type === "message") {
          messages.push(line);
          continue;
        }

        if (line.type === "checkpoint") {
          summaryMessageId = line.summaryMessageId;
          continue;
        }

        if (line.type === "snapshot") {
          historySnapshot = line.snapshot;
        }
      } catch {
        // skip malformed JSONL lines
      }
    }

    return Promise.resolve({
      sessionId,
      summaryMessageId,
      historySnapshot,
      messages,
    });
  }

  deleteSession(sessionId: string): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    try {
      rmSync(filePath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return Promise.resolve();
  }
}
