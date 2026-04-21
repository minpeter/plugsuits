import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSpinnerTicker,
  PENDING_SPINNER_FRAMES,
  PENDING_SPINNER_INTERVAL_MS,
  stylePendingIndicator,
} from "./pending-spinner";

describe("pending-spinner fixtures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("locks the canonical braille frame set", () => {
    expect([...PENDING_SPINNER_FRAMES]).toEqual([
      "⠋",
      "⠙",
      "⠹",
      "⠸",
      "⠼",
      "⠴",
      "⠦",
      "⠧",
      "⠇",
      "⠏",
    ]);
  });

  it("locks the frame interval at 80ms", () => {
    expect(PENDING_SPINNER_INTERVAL_MS).toBe(80);
  });

  it("locks the indicator ANSI byte sequence (cyan frame + dim message)", () => {
    expect(stylePendingIndicator("⠋", "Executing...")).toBe(
      "\x1b[36m⠋\x1b[0m \x1b[2mExecuting...\x1b[0m"
    );
    expect(stylePendingIndicator("⠙", "Thinking...")).toBe(
      "\x1b[36m⠙\x1b[0m \x1b[2mThinking...\x1b[0m"
    );
    expect(stylePendingIndicator("⠋", "Working...")).toBe(
      "\x1b[36m⠋\x1b[0m \x1b[2mWorking...\x1b[0m"
    );
  });

  it("emits the initial frame synchronously by default", () => {
    const frames: string[] = [];
    const ticker = createSpinnerTicker((frame) => frames.push(frame));

    expect(frames).toEqual(["⠋"]);
    ticker.stop();
  });

  it("advances frames on the canonical interval", () => {
    const frames: string[] = [];
    const ticker = createSpinnerTicker((frame) => frames.push(frame));

    vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS);
    vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS);
    vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS);

    expect(frames).toEqual(["⠋", "⠙", "⠹", "⠸"]);
    ticker.stop();
  });

  it("wraps around after the final frame", () => {
    const frames: string[] = [];
    const ticker = createSpinnerTicker((frame) => frames.push(frame));

    for (const _ of PENDING_SPINNER_FRAMES) {
      vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS);
    }

    expect(frames).toEqual([...PENDING_SPINNER_FRAMES, "⠋"]);
    ticker.stop();
  });

  it("stop() halts further frame emission", () => {
    const frames: string[] = [];
    const ticker = createSpinnerTicker((frame) => frames.push(frame));

    vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS);
    ticker.stop();
    vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS * 5);

    expect(frames).toEqual(["⠋", "⠙"]);
  });

  it("stop() is idempotent", () => {
    const frames: string[] = [];
    const ticker = createSpinnerTicker((frame) => frames.push(frame));
    ticker.stop();
    expect(() => ticker.stop()).not.toThrow();
    vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS * 3);
    expect(frames).toEqual(["⠋"]);
  });

  it("emitInitialFrame: false skips the synchronous first call", () => {
    const frames: string[] = [];
    const ticker = createSpinnerTicker((frame) => frames.push(frame), {
      emitInitialFrame: false,
    });

    expect(frames).toEqual([]);
    vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS);
    expect(frames).toEqual(["⠙"]);
    ticker.stop();
  });

  it("respects a custom intervalMs", () => {
    const frames: string[] = [];
    const ticker = createSpinnerTicker((frame) => frames.push(frame), {
      intervalMs: 200,
    });

    vi.advanceTimersByTime(80);
    expect(frames).toEqual(["⠋"]);
    vi.advanceTimersByTime(120);
    expect(frames).toEqual(["⠋", "⠙"]);
    ticker.stop();
  });
});
