import { describe, expect, it } from "bun:test";
import {
  applyHashlineEdits,
  applyHashlineEditsWithReport,
  computeLineHash,
  HashlineMismatchError,
} from ".";

const OVERLAPPING_REGEX = /[Oo]verlapping/;

describe("hashline - edit operations", () => {
  it("replaces anchored line", () => {
    const content = "alpha\nbravo\ncharlie";
    const bravoHash = computeLineHash(2, "bravo");
    const result = applyHashlineEdits(content, [
      { op: "replace", pos: `2#${bravoHash}`, lines: ["BRAVO"] },
    ]);
    expect(result).toBe("alpha\nBRAVO\ncharlie");
  });

  it("inserts with append and prepend", () => {
    const content = "a\nb";
    const bHash = computeLineHash(2, "b");
    const result = applyHashlineEdits(content, [
      { op: "prepend", pos: `2#${bHash}`, lines: ["before-b"] },
      { op: "append", pos: `2#${bHash}`, lines: ["after-b"] },
    ]);
    expect(result).toBe("a\nbefore-b\nb\nafter-b");
  });

  it("appends at EOF", () => {
    const content = "a\nb";
    const result = applyHashlineEdits(content, [
      { op: "append", lines: ["c"] },
    ]);
    expect(result).toBe("a\nb\nc");
  });

  it("preserves append order for same anchor", () => {
    const content = "a\nb";
    const bHash = computeLineHash(2, "b");
    const result = applyHashlineEdits(content, [
      { op: "append", pos: `2#${bHash}`, lines: ["first"] },
      { op: "append", pos: `2#${bHash}`, lines: ["second"] },
    ]);
    expect(result).toBe("a\nb\nsecond\nfirst");
  });

  it("dedupes semantically identical edits", () => {
    const content = "a\nb";
    const bHash = computeLineHash(2, "b");
    const report = applyHashlineEditsWithReport(content, [
      { op: "append", pos: `2#${bHash}`, lines: ["dup"] },
      { op: "append", pos: `2#${bHash}`, lines: ["dup"] },
    ]);
    expect(report.content).toBe("a\nb\ndup");
    expect(report.deduplicatedEdits).toBe(1);
  });

  it("preserves prepend order for same anchor", () => {
    const content = "a\nb";
    const bHash = computeLineHash(2, "b");
    const result = applyHashlineEdits(content, [
      { op: "prepend", pos: `2#${bHash}`, lines: ["first"] },
      { op: "prepend", pos: `2#${bHash}`, lines: ["second"] },
    ]);
    expect(result).toBe("a\nsecond\nfirst\nb");
  });

  it("throws mismatch error for stale anchors", () => {
    const content = "one\ntwo\nthree";
    const staleHash = computeLineHash(2, "TWO");
    expect(() =>
      applyHashlineEdits(content, [
        { op: "replace", pos: `2#${staleHash}`, lines: ["two-updated"] },
      ])
    ).toThrow(HashlineMismatchError);
  });

  it("collects remaps for stale anchors", () => {
    const content = "one\ntwo\nthree";
    const staleHash = computeLineHash(2, "TWO");
    try {
      applyHashlineEdits(content, [
        { op: "replace", pos: `2#${staleHash}`, lines: ["two-updated"] },
      ]);
      throw new Error("Expected HashlineMismatchError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HashlineMismatchError);
      const mismatchError = error as HashlineMismatchError;
      const expectedKey = `2#${staleHash}`;
      const actualValue = mismatchError.remaps.get(expectedKey);
      expect(actualValue).toBe(`2#${computeLineHash(2, "two")}`);
    }
  });

  it("formats mismatch context lines with pipe delimiter", () => {
    const content = "one\ntwo\nthree";
    const staleHash = computeLineHash(2, "TWO");
    try {
      applyHashlineEdits(content, [
        { op: "replace", pos: `2#${staleHash}`, lines: ["two-updated"] },
      ]);
      throw new Error("Expected HashlineMismatchError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HashlineMismatchError);
      const message = (error as Error).message;
      expect(message).toContain(`>>> 2#${computeLineHash(2, "two")}|two`);
    }
  });

  it("silently deletes lines via replace with empty content", () => {
    const content = "hello\nworld";
    const helloHash = computeLineHash(1, "hello");
    const result = applyHashlineEdits(content, [
      { op: "replace", pos: `1#${helloHash}`, lines: [] },
    ]);
    expect(result).toBe("world");
  });

  it("reports noop edits", () => {
    const content = "hello\nworld";
    const helloHash = computeLineHash(1, "hello");
    const report = applyHashlineEditsWithReport(content, [
      { op: "replace", pos: `1#${helloHash}`, lines: ["hello"] },
    ]);
    expect(report.noopEdits).toBe(1);
    expect(report.content).toBe(content);
  });

  it("detects overlapping range edits", () => {
    const content = "a\nb\nc\nd\ne";
    const aH = computeLineHash(1, "a");
    const cH = computeLineHash(3, "c");
    const bH = computeLineHash(2, "b");
    const dH = computeLineHash(4, "d");
    expect(() =>
      applyHashlineEdits(content, [
        {
          op: "replace",
          pos: `1#${aH}`,
          end: `3#${cH}`,
          lines: ["x", "y", "z"],
        },
        {
          op: "replace",
          pos: `2#${bH}`,
          end: `4#${dH}`,
          lines: ["x", "y", "z"],
        },
      ])
    ).toThrow(OVERLAPPING_REGEX);
  });
});
