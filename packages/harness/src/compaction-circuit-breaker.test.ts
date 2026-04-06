import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionCircuitBreaker } from "./compaction-circuit-breaker";

describe("CompactionCircuitBreaker", () => {
  let breaker: CompactionCircuitBreaker;

  beforeEach(() => {
    breaker = new CompactionCircuitBreaker({
      cooldownMs: 1000,
      maxConsecutiveFailures: 3,
    });
  });

  it("starts closed", () => {
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.isClosed()).toBe(true);
    expect(breaker.getState()).toEqual({
      failures: 0,
      isOpen: false,
      lastFailureAt: null,
      reason: null,
    });
  });

  it("opens after max consecutive failures", () => {
    breaker.recordFailure("failure-1");
    breaker.recordFailure("failure-2");

    expect(breaker.isOpen()).toBe(false);
    expect(breaker.isClosed()).toBe(true);

    breaker.recordFailure("failure-3");

    expect(breaker.isOpen()).toBe(true);
    expect(breaker.isClosed()).toBe(false);

    const state = breaker.getState();
    expect(state.failures).toBe(3);
    expect(state.isOpen).toBe(true);
    expect(state.lastFailureAt).toEqual(expect.any(Number));
    expect(state.reason).toBe("failure-3");
  });

  it("auto-closes after cooldown", () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(10_000);

      const timedBreaker = new CompactionCircuitBreaker({
        cooldownMs: 1000,
        maxConsecutiveFailures: 2,
      });

      timedBreaker.recordFailure("first");
      timedBreaker.recordFailure("second");
      expect(timedBreaker.isOpen()).toBe(true);

      vi.advanceTimersByTime(999);
      expect(timedBreaker.isOpen()).toBe(true);

      vi.advanceTimersByTime(1);
      expect(timedBreaker.isOpen()).toBe(false);
      expect(timedBreaker.isClosed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getState returns a consistent snapshot after cooldown expiry", () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(10_000);

      const timedBreaker = new CompactionCircuitBreaker({
        cooldownMs: 1000,
        maxConsecutiveFailures: 2,
      });

      timedBreaker.recordFailure("first");
      timedBreaker.recordFailure("second");

      expect(timedBreaker.getState()).toEqual({
        failures: 2,
        isOpen: true,
        lastFailureAt: 10_000,
        reason: "second",
      });

      vi.advanceTimersByTime(1000);

      // After cooldown expires, all fields must reflect the post-reset state
      // consistently — no mix of pre-reset failures with post-reset nulls.
      expect(timedBreaker.getState()).toEqual({
        failures: 0,
        isOpen: false,
        lastFailureAt: null,
        reason: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset force-resets state", () => {
    breaker.recordFailure("failure-1");
    breaker.recordFailure("failure-2");
    breaker.recordFailure("failure-3");
    expect(breaker.isOpen()).toBe(true);

    breaker.reset();

    expect(breaker.getState()).toEqual({
      failures: 0,
      isOpen: false,
      lastFailureAt: null,
      reason: null,
    });
    expect(breaker.isClosed()).toBe(true);
  });

  it("recordSuccess resets failure count", () => {
    breaker.recordFailure("failure-1");
    breaker.recordFailure("failure-2");

    breaker.recordSuccess();

    expect(breaker.getState()).toEqual({
      failures: 0,
      isOpen: false,
      lastFailureAt: null,
      reason: null,
    });
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.isClosed()).toBe(true);
  });

  it("stays open until reset when cooldown is disabled", () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(10_000);

      const sessionScopedBreaker = new CompactionCircuitBreaker({
        cooldownMs: 0,
        maxConsecutiveFailures: 2,
      });

      sessionScopedBreaker.recordFailure("first");
      sessionScopedBreaker.recordFailure("second");
      expect(sessionScopedBreaker.isOpen()).toBe(true);

      vi.advanceTimersByTime(60_000);
      expect(sessionScopedBreaker.isOpen()).toBe(true);

      sessionScopedBreaker.resetForNewSession();
      expect(sessionScopedBreaker.isOpen()).toBe(false);
      expect(sessionScopedBreaker.isClosed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
