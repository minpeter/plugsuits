import { mkdirSync } from "node:fs";
import type { HistorySnapshot } from "./history-snapshot";
import { SessionStore } from "./session-store";
import type { SnapshotStore } from "./snapshot-store";

export class FileSnapshotStore implements SnapshotStore {
  private readonly sessionStore: SessionStore;

  constructor(baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
    this.sessionStore = new SessionStore(baseDir);
  }

  async load(sessionId: string): Promise<HistorySnapshot | null> {
    const session = await this.sessionStore.loadSession(sessionId);

    if (session === null) {
      return null;
    }

    return {
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
    };
  }

  async save(sessionId: string, snapshot: HistorySnapshot): Promise<void> {
    await this.sessionStore.deleteSession(sessionId);

    for (const msg of snapshot.messages) {
      await this.sessionStore.appendMessage(sessionId, {
        type: "message",
        id: msg.id,
        message: msg.message,
        createdAt: msg.createdAt ?? Date.now(),
        isSummary: msg.isSummary ?? false,
        originalContent: msg.originalContent,
      });
    }

    const summaryMessageId = snapshot.compactionState?.summaryMessageId;

    if (summaryMessageId) {
      await this.sessionStore.updateCheckpoint(sessionId, summaryMessageId);
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.sessionStore.deleteSession(sessionId);
  }
}
