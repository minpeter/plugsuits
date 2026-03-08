import { describe, expect, it } from "bun:test";
import {
  applyHashlineEdits,
  applyHashlineEditsWithReport,
} from "./edit-operations";
import { computeLineHash } from "./hash-computation";
import { HashlineMismatchError } from "./validation";

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
    // After sorting (line2 at end) and dedupe: only one "dup" remains
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

  it("deduplication is order-independent (sorted before dedupe)", () => {
    // Same edits in different input order should produce same result
    // Sorting is done by line number (bottom-to-top), then dedupe
    const content = "a\nb\nc";
    const bHash = computeLineHash(2, "b");
    const cHash = computeLineHash(3, "c");

    const editsOrder1 = [
      { op: "append" as const, pos: `2#${bHash}`, lines: ["dup"] },
      { op: "append" as const, pos: `3#${cHash}`, lines: ["unique"] },
      { op: "append" as const, pos: `2#${bHash}`, lines: ["dup"] },
    ];

    const editsOrder2 = [
      { op: "append" as const, pos: `2#${bHash}`, lines: ["dup"] },
      { op: "append" as const, pos: `2#${bHash}`, lines: ["dup"] },
      { op: "append" as const, pos: `3#${cHash}`, lines: ["unique"] },
    ];

    const report1 = applyHashlineEditsWithReport(content, editsOrder1);
    const report2 = applyHashlineEditsWithReport(content, editsOrder2);

    // Both should produce the same result: sorted by line (3, then 2), deduped
    expect(report1.content).toBe(report2.content);
    expect(report1.deduplicatedEdits).toBe(report2.deduplicatedEdits);
    expect(report1.deduplicatedEdits).toBe(1);
    // After sorting: line3 first, then line2 (bottom-to-top)
    // Applied: "c" + "unique", then "b" + "dup"
    expect(report1.content).toBe("a\nb\ndup\nc\nunique");
  });

  it("overlapping detection works with sorted edits (not original order)", () => {
    // Overlapping detection should work correctly after sorting
    const content = "a\nb\nc\nd";
    const bH = computeLineHash(2, "b");
    const dH = computeLineHash(4, "d");
    const aH = computeLineHash(1, "a");
    const cH = computeLineHash(3, "c");

    // Provide edits in reverse line order - should still detect overlap
    expect(() =>
      applyHashlineEdits(content, [
        {
          op: "replace",
          pos: `2#${bH}`,
          end: `4#${dH}`,
          lines: ["x", "y", "z"],
        },
        {
          op: "replace",
          pos: `1#${aH}`,
          end: `3#${cH}`,
          lines: ["x", "y", "z"],
        },
      ])
    ).toThrow(OVERLAPPING_REGEX);
  });
});
