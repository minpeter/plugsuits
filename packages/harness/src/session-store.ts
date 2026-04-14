import type { MessageLine } from "./compaction-types";
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
