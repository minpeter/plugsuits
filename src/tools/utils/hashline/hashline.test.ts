import { describe, expect, it } from "bun:test";
import {
  applyHashlineEdits,
  computeFileHash,
  computeLineHash,
  HashlineMismatchError,
  parseHashlineText,
  parseLineTag,
} from "./hashline";

const HASH_PATTERN = /^[ZPMQVRWSNKTXJBYH]{2}$/;

describe("hashline", () => {
  it("computes 2-char line hashes", () => {
    const hash = computeLineHash(1, "hello");
    expect(hash).toMatch(HASH_PATTERN);
  });

  it("computes deterministic file hash", () => {
    const a = computeFileHash("a\nb\n");
    const b = computeFileHash("a\nb\n");
    const c = computeFileHash("a\nB\n");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("parses line tags with noisy prefixes", () => {
    expect(parseLineTag(">>> 12#ZP:line")).toEqual({
      line: 12,
      hash: "ZP",
    });
  });

  it("parses line tags embedded in grep-style paths", () => {
    expect(parseLineTag("./file1.ts:7#MQ | const foo = 1;")).toEqual({
      line: 7,
      hash: "MQ",
    });
    expect(parseLineTag("C:\\repo\\file.ts:9#vr | const bar = 2;")).toEqual({
      line: 9,
      hash: "VR",
    });
  });

  it("replaces anchored line", () => {
    const content = "alpha\nbravo\ncharlie\n";
    const bravoHash = computeLineHash(2, "bravo");
    const result = applyHashlineEdits(content, [
      {
        op: "replace",
        pos: { line: 2, hash: bravoHash },
        lines: ["BRAVO"],
      },
    ]);

    expect(result.lines).toBe("alpha\nBRAVO\ncharlie\n");
    expect(result.firstChangedLine).toBe(2);
  });

  it("inserts with append and prepend", () => {
    const content = "a\nb\n";
    const bHash = computeLineHash(2, "b");

    const result = applyHashlineEdits(content, [
      {
        op: "prepend",
        pos: { line: 2, hash: bHash },
        lines: ["before-b"],
      },
      {
        op: "append",
        pos: { line: 2, hash: bHash },
        lines: ["after-b"],
      },
    ]);

    expect(result.lines).toBe("a\nbefore-b\nb\nafter-b\n");
  });

  it("appends at EOF before trailing newline sentinel", () => {
    const content = "a\nb\n";
    const result = applyHashlineEdits(content, [
      {
        op: "append",
        lines: ["c"],
      },
    ]);

    expect(result.lines).toBe("a\nb\nc\n");
    expect(result.firstChangedLine).toBe(3);
  });

  it("preserves append order for same anchor", () => {
    const content = "a\nb\n";
    const bHash = computeLineHash(2, "b");

    const result = applyHashlineEdits(content, [
      {
        op: "append",
        pos: { line: 2, hash: bHash },
        lines: ["first"],
      },
      {
        op: "append",
        pos: { line: 2, hash: bHash },
        lines: ["second"],
      },
    ]);

    expect(result.lines).toBe("a\nb\nfirst\nsecond\n");
  });

  it("preserves prepend order for same anchor", () => {
    const content = "a\nb\n";
    const bHash = computeLineHash(2, "b");

    const result = applyHashlineEdits(content, [
      {
        op: "prepend",
        pos: { line: 2, hash: bHash },
        lines: ["first"],
      },
      {
        op: "prepend",
        pos: { line: 2, hash: bHash },
        lines: ["second"],
      },
    ]);

    expect(result.lines).toBe("a\nfirst\nsecond\nb\n");
  });

  it("throws mismatch error for stale anchors", () => {
    const content = "one\ntwo\nthree\n";
    const staleHash = computeLineHash(2, "TWO");

    expect(() =>
      applyHashlineEdits(content, [
        {
          op: "replace",
          pos: { line: 2, hash: staleHash },
          lines: ["two-updated"],
        },
      ])
    ).toThrow(HashlineMismatchError);
  });

  it("strips copied hashline prefixes from string inputs", () => {
    const parsed = parseHashlineText("1#ZP:foo\n2#MQ:bar\n");
    expect(parsed).toEqual(["foo", "bar"]);
  });
});
