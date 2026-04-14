import { describe, expect, it } from "vitest";
import { decodeSessionId, encodeSessionId } from "./session-store";

describe("session-store helpers", () => {
  it("encodeSessionId passes through alphanumeric and hyphen only", () => {
    expect(encodeSessionId("test-session-1")).toBe("test-session-1");
    expect(encodeSessionId("ABCdef-789")).toBe("ABCdef-789");
  });

  it("encodeSessionId uses fixed-width 4-digit hex escapes", () => {
    expect(encodeSessionId("abc_def")).toBe("abc_005fdef");
    expect(encodeSessionId(":")).toBe("_003a");
    expect(encodeSessionId("_003a")).toBe("_005f003a");
    expect(encodeSessionId(":")).not.toBe(encodeSessionId("_003a"));
  });

  it("encodeSessionId is injective for multi-byte BMP characters", () => {
    expect(encodeSessionId(":b")).toBe("_003ab");
    expect(encodeSessionId("\u03AB")).toBe("_03ab");
    expect(encodeSessionId(":b")).not.toBe(encodeSessionId("\u03AB"));
  });

  it("encodeSessionId escapes special characters deterministically", () => {
    expect(encodeSessionId("a:b")).toBe("a_003ab");
    expect(encodeSessionId("foo/bar")).toBe("foo_002fbar");
    expect(encodeSessionId("a.b.c")).toBe("a_002eb_002ec");
  });

  it("encodeSessionId/decodeSessionId round-trips", () => {
    const cases = [
      "user@example.com",
      "session/123",
      "a:b:c",
      "normal-id",
      "space here",
    ];
    for (const id of cases) {
      expect(decodeSessionId(encodeSessionId(id))).toBe(id);
    }
  });

  it("encodeSessionId rejects empty string", () => {
    expect(() => encodeSessionId("")).toThrow("sessionId must not be empty");
  });
});
