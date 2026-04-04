export interface CircuitBreakerConfig {
  cooldownMs?: number;
  maxConsecutiveFailures?: number;
}

export type CompactionCircuitBreakerOptions = CircuitBreakerConfig;

export interface CompactionCircuitBreakerState {
  failures: number;
  isOpen: boolean;
  lastFailureAt: number | null;
  reason: string | null;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

export class CompactionCircuitBreaker {
  private readonly cooldownMs: number;
  private failures = 0;
  private lastFailureAt: number | null = null;
  private readonly maxConsecutiveFailures: number;
  private reason: string | null = null;

  constructor(options: CircuitBreakerConfig = {}) {
    this.maxConsecutiveFailures =
      typeof options.maxConsecutiveFailures === "number" &&
      Number.isFinite(options.maxConsecutiveFailures) &&
      options.maxConsecutiveFailures > 0
        ? Math.floor(options.maxConsecutiveFailures)
        : DEFAULT_MAX_CONSECUTIVE_FAILURES;

    this.cooldownMs =
      typeof options.cooldownMs === "number" &&
      Number.isFinite(options.cooldownMs) &&
      options.cooldownMs >= 0
        ? Math.floor(options.cooldownMs)
        : DEFAULT_COOLDOWN_MS;
  }

  recordFailure(reason?: string): void {
    this.failures += 1;
    this.lastFailureAt = Date.now();
    this.reason = reason ?? null;
  }

  recordSuccess(): void {
    this.reset();
  }

  isOpen(): boolean {
    if (this.failures < this.maxConsecutiveFailures) {
      return false;
    }

    if (this.cooldownMs === 0) {
      return true;
    }

    if (this.lastFailureAt === null) {
      return false;
    }

    const cooldownExpired = Date.now() - this.lastFailureAt >= this.cooldownMs;
    if (cooldownExpired) {
      this.reset();
      return false;
    }

    return true;
  }

  isClosed(): boolean {
    return !this.isOpen();
  }

  getState(): CompactionCircuitBreakerState {
    return {
      failures: this.failures,
      isOpen: this.isOpen(),
      lastFailureAt: this.lastFailureAt,
      reason: this.reason,
    };
  }

  reset(): void {
    this.failures = 0;
    this.lastFailureAt = null;
    this.reason = null;
  }

  resetForNewSession(): void {
    this.reset();
  }
}
