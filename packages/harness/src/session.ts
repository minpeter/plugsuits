import { randomUUID } from "node:crypto";

export class SessionManager {
  private sessionId: string | null = null;
  private readonly prefix: string;

  constructor(prefix = "session") {
    this.prefix = prefix;
  }

  initialize(): string {
    this.sessionId = `${this.prefix}-${randomUUID()}`;
    return this.sessionId;
  }

  getId(): string {
    if (!this.sessionId) {
      throw new Error("Session not initialized. Call initialize() first.");
    }
    return this.sessionId;
  }

  isActive(): boolean {
    return this.sessionId !== null;
  }
}
