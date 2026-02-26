import { describe, expect, it } from "bun:test";
import {
  computeLineHash,
  HashlineMismatchError,
  parseHashlineText,
  parseLineRef,
  parseLineTag,
  tryParseLineTag,
  validateLineRef,
  validateLineRefs,
} from ".";

describe("hashline - validation", () => {
  it("parses line refs with noisy prefixes", () => {
    expect(parseLineRef(">>> 12#ZP")).toEqual({
      line: 12,
      hash: "ZP",
    });
  });

  it("parses line tags via alias", () => {
    expect(parseLineTag("42#VK")).toEqual({
      line: 42,
      hash: "VK",
    });
  });

  it("parses anchors with diff marker prefix", () => {
    expect(parseLineRef(">>> 42#VK")).toEqual({ line: 42, hash: "VK" });
  });

  it("parses anchors with spaces around #", () => {
    expect(parseLineRef("42 # VK")).toEqual({ line: 42, hash: "VK" });
  });

  it("strips pipe-delimited content from refs", () => {
    expect(parseLineRef("12#ZP|some content")).toEqual({
      line: 12,
      hash: "ZP",
    });
  });

  it("parses first ref from multiline input (ignores rest)", () => {
    const result = parseLineRef("1#HK|alpha\n2#KM|bravo");
    expect(result).toEqual({ line: 1, hash: "HK" });
  });

  it("returns undefined for invalid tags via tryParseLineTag", () => {
    expect(tryParseLineTag("invalid")).toBeUndefined();
    expect(tryParseLineTag(undefined)).toBeUndefined();
  });

  it("strips copied hashline prefixes from string inputs", () => {
    const parsed = parseHashlineText("1#ZP|foo\n2#MQ|bar\n");
    expect(parsed).toEqual(["foo", "bar", ""]);
  });

  it("preserves markdown list lines starting with '-'", () => {
    const parsed = parseHashlineText("- item one\n- item two\n");
    expect(parsed).toEqual(["- item one", "- item two", ""]);
  });

  it("preserves checkbox list lines", () => {
    const parsed = parseHashlineText("- [ ] task one\n- [x] task two\n");
    expect(parsed).toEqual(["- [ ] task one", "- [x] task two", ""]);
  });

  it("keeps lines that start with '++' intact", () => {
    const parsed = parseHashlineText("++conflict marker\n++another\n");
    expect(parsed).toEqual(["++conflict marker", "++another", ""]);
  });

  it("validates a matching line reference", () => {
    const lines = ["a", "b", "c"];
    const ref = `2#${computeLineHash(2, "b")}`;
    expect(() => validateLineRef(lines, ref)).not.toThrow();
  });

  it("throws mismatch error from validateLineRef", () => {
    const lines = ["a", "b", "c"];
    const ref = `2#${computeLineHash(2, "B")}`;
    expect(() => validateLineRef(lines, ref)).toThrow(HashlineMismatchError);
  });

  it("batch validates multiple refs", () => {
    const lines = ["a", "b", "c"];
    const refs = [
      `1#${computeLineHash(1, "a")}`,
      `2#${computeLineHash(2, "b")}`,
    ];
    expect(() => validateLineRefs(lines, refs)).not.toThrow();
  });

  it("batch validates collecting multiple mismatches", () => {
    const lines = ["a", "b", "c"];
    const staleB = computeLineHash(2, "B");
    const staleC = computeLineHash(3, "C");
    const refs = [`2#${staleB}`, `3#${staleC}`];

    try {
      validateLineRefs(lines, refs);
      throw new Error("Expected error");
    } catch (error) {
      expect(error).toBeInstanceOf(HashlineMismatchError);
      const e = error as HashlineMismatchError;
      expect(e.remaps.size).toBe(2);
    }
  });
});
