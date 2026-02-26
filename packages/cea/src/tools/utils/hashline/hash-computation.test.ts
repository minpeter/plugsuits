import { describe, expect, it } from "bun:test";
import {
  computeFileHash,
  computeLineHash,
  streamHashLinesFromLines,
  streamHashLinesFromUtf8,
} from ".";

const HASH_PATTERN = /^[ZPMQVRWSNKTXJBYH]{2}$/;

describe("hashline - hash computation", () => {
  it("computes 2-char line hashes", () => {
    const hash = computeLineHash(1, "hello");
    expect(hash).toMatch(HASH_PATTERN);
  });

  it("uses line number for symbol-only lines", () => {
    const a = computeLineHash(1, "***");
    const b = computeLineHash(2, "***");
    expect(a).not.toBe(b);
  });

  it("does not use line number for alphanumeric lines", () => {
    const a = computeLineHash(1, "hello");
    const b = computeLineHash(2, "hello");
    expect(a).toBe(b);
  });

  it("computes deterministic file hash", () => {
    const a = computeFileHash("a\nb\n");
    const b = computeFileHash("a\nb\n");
    const c = computeFileHash("a\nB\n");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("streams hashline numbering from lines", async () => {
    const chunks: string[] = [];
    for await (const chunk of streamHashLinesFromLines(["a", "b", "c"], {
      maxChunkLines: 2,
    })) {
      chunks.push(chunk);
    }

    const output = chunks.join("\n");
    expect(output).toBe(
      [
        `1#${computeLineHash(1, "a")}|a`,
        `2#${computeLineHash(2, "b")}|b`,
        `3#${computeLineHash(3, "c")}|c`,
      ].join("\n")
    );
  });

  it("streams hashline numbering from UTF-8 bytes", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a\nb\n"));
        controller.enqueue(new TextEncoder().encode("c\n"));
        controller.close();
      },
    });

    const chunks: string[] = [];
    for await (const chunk of streamHashLinesFromUtf8(stream, {
      maxChunkLines: 2,
    })) {
      chunks.push(chunk);
    }

    const output = chunks.join("\n");
    expect(output).toBe(
      [
        `1#${computeLineHash(1, "a")}|a`,
        `2#${computeLineHash(2, "b")}|b`,
        `3#${computeLineHash(3, "c")}|c`,
        `4#${computeLineHash(4, "")}|`,
      ].join("\n")
    );
  });
});
