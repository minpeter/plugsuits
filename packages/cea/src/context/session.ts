let currentSessionId: string | null = null;

export function initializeSession(): string {
  currentSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return currentSessionId;
}

export function getSessionId(): string {
  if (!currentSessionId) {
    throw new Error("Session not initialized. Call initializeSession() first.");
  }
  return currentSessionId;
}

export function setSessionId(sessionId: string): void {
  currentSessionId = sessionId;
}

export function hasActiveSession(): boolean {
  return currentSessionId !== null;
}
