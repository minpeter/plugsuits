import type { HistorySnapshot } from "./history-snapshot";

/**
 * Persistence abstraction for CheckpointHistory state.
 *
 * Contract: after `save(id, snapshot)` completes, a subsequent `load(id)`
 * MUST return a snapshot equivalent to what was saved (replace semantics).
 * Whether the underlying implementation uses append-log, overwrite, or
 * database rows is an implementation detail — the observable contract is
 * full replace.
 */
export interface SnapshotStore {
  /** Load the last saved snapshot for the given session. Returns null if not found. */
  load(sessionId: string): Promise<HistorySnapshot | null>;
  /** Persist the snapshot. Replaces any previously saved state for this session. */
  save(sessionId: string, snapshot: HistorySnapshot): Promise<void>;
  /** Remove the stored snapshot for this session. No-op if not found. */
  delete(sessionId: string): Promise<void>;
}

/** In-memory implementation for testing and ephemeral use. */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly store = new Map<string, HistorySnapshot>();

  async load(sessionId: string): Promise<HistorySnapshot | null> {
    await Promise.resolve();
    return this.store.get(sessionId) ?? null;
  }

  async save(sessionId: string, snapshot: HistorySnapshot): Promise<void> {
    await Promise.resolve();
    this.store.set(sessionId, snapshot);
  }

  async delete(sessionId: string): Promise<void> {
    await Promise.resolve();
    this.store.delete(sessionId);
  }
}
