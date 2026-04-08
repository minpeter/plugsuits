import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MessageLine, SessionFileLine } from "./compaction-types";

export interface SessionData {
  messages: MessageLine[];
  sessionId: string;
  summaryMessageId: string | null;
}

export class SessionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private getFilePath(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.jsonl`);
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

  loadSession(sessionId: string): Promise<SessionData | null> {
    const filePath = this.getFilePath(sessionId);

    if (!existsSync(filePath)) {
      return Promise.resolve(null);
    }

    const content = readFileSync(filePath, "utf8");
    const rawLines = content.split("\n");
    const messages: MessageLine[] = [];
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
        }
      } catch {
        // skip malformed JSONL lines
      }
    }

    return Promise.resolve({
      sessionId,
      summaryMessageId,
      messages,
    });
  }

  deleteSession(sessionId: string): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    try {
      rmSync(filePath, { force: true });
    } catch {
      // File already deleted or inaccessible
    }
    return Promise.resolve();
  }
}
