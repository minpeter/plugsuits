import { randomUUID } from "node:crypto";
let currentSessionId: string | null = null;

export function initializeSession(): string {
  currentSessionId = `session-${randomUUID()}`;
  return currentSessionId;
}

export function getSessionId(): string {
  if (!currentSessionId) {
    throw new Error("Session not initialized. Call initializeSession() first.");
  }
  return currentSessionId;
}

export function hasActiveSession(): boolean {
  return currentSessionId !== null;
}
