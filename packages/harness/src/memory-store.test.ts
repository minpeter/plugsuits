import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileMemoryStore, InMemoryStore } from "./memory-store";

describe("InMemoryStore", () => {
  it("supports read/write/isEmpty lifecycle", async () => {
    const store = new InMemoryStore();

    expect(await store.read()).toBe("");
    expect(await store.isEmpty()).toBe(true);

    await store.write("hello");
    expect(await store.read()).toBe("hello");
    expect(await store.isEmpty()).toBe(false);

    await store.write("   \n\t");
    expect(await store.isEmpty()).toBe(true);
  });
});

describe("FileMemoryStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-store-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("returns empty content when file does not exist", async () => {
    const store = new FileMemoryStore(join(tmpDir, "missing", "memory.md"));

    expect(await store.read()).toBe("");
    expect(await store.isEmpty()).toBe(true);
  });

  it("writes and reads persisted memory", async () => {
    const store = new FileMemoryStore(join(tmpDir, "nested", "memory.md"));

    await store.write("# Notes\nSaved state");

    expect(await store.read()).toBe("# Notes\nSaved state");
    expect(await store.isEmpty()).toBe(false);
  });

  it("treats whitespace-only file content as empty", async () => {
    const store = new FileMemoryStore(join(tmpDir, "memory.md"));

    await store.write("   \n\n\t");

    expect(await store.isEmpty()).toBe(true);
  });
});
