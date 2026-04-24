import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { MessageLine, SessionFileLine } from "./compaction-types";
import { ensureDirIgnoredByGit } from "./gitignore-sync";
import type { HistorySnapshot } from "./history-snapshot";
import { encodeSessionId, type SessionData } from "./session-store";
import type { SnapshotStore } from "./snapshot-store";
import { createRuntimeUUID } from "./uuid";

export const SESSIONS_SUBDIR = "sessions";

export interface FileSnapshotStoreOptions {
  /**
   * When true (default), append the configured top-level directory to the
   * nearest ancestor `.gitignore` if not already listed. Best-effort — never
   * fails initialization. Set to `false` to disable, e.g. in tests or when
   * writing outside of a git worktree on purpose.
   */
  autoGitignore?: boolean;
}

export class FileSnapshotStore implements SnapshotStore {
  readonly rootDir: string;
  readonly sessionsDir: string;

  constructor(rootDir: string, options: FileSnapshotStoreOptions = {}) {
    this.rootDir = resolve(rootDir);
    this.sessionsDir = join(this.rootDir, SESSIONS_SUBDIR);
    mkdirSync(this.sessionsDir, { recursive: true });

    if (options.autoGitignore !== false) {
      ensureDirIgnoredByGit(this.rootDir);
    }
  }

  load(sessionId: string): Promise<HistorySnapshot | null> {
    const session = this.loadSession(sessionId);

    if (session === null) {
      return Promise.resolve(null);
    }

    if (session.historySnapshot) {
      return Promise.resolve(session.historySnapshot);
    }

    return Promise.resolve({
      messages: session.messages.map((messageLine) => ({
        id: messageLine.id,
        message: messageLine.message,
        createdAt: messageLine.createdAt,
        isSummary: messageLine.isSummary,
        originalContent: messageLine.originalContent,
      })),
      revision: 0,
      contextLimit: 0,
      systemPromptTokens: 0,
      toolSchemasTokens: 0,
      compactionState: {
        summaryMessageId: session.summaryMessageId,
      },
    });
  }

  save(sessionId: string, snapshot: HistorySnapshot): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    const tempFilePath = `${filePath}.${createRuntimeUUID()}.tmp`;
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

  delete(sessionId: string): Promise<void> {
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

  private getFilePath(sessionId: string): string {
    const encoded = encodeSessionId(sessionId);
    return join(this.sessionsDir, `${encoded}.jsonl`);
  }

  private loadSession(sessionId: string): SessionData | null {
    const filePath = this.getFilePath(sessionId);

    if (!existsSync(filePath)) {
      return null;
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

    return {
      sessionId,
      summaryMessageId,
      historySnapshot,
      messages,
    };
  }
}
