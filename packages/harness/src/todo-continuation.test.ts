import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "./session";
import { TodoContinuation } from "./todo-continuation";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TodoContinuation", () => {
  it("reads todos from an absolute todo directory", async () => {
    const todoDir = mkdtempSync(join(tmpdir(), "todo-continuation-"));
    tempDirs.push(todoDir);

    const sessionManager = new SessionManager("test");
    const sessionId = sessionManager.initialize();

    writeFileSync(
      join(todoDir, `${sessionId}.json`),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        todos: [
          {
            id: "1",
            content: "ship fix",
            priority: "high",
            status: "pending",
          },
        ],
      })
    );

    const continuation = new TodoContinuation({ todoDir }, sessionManager);

    await expect(continuation.getIncompleteTodos()).resolves.toEqual([
      {
        id: "1",
        content: "ship fix",
        priority: "high",
        status: "pending",
      },
    ]);
  });
});
