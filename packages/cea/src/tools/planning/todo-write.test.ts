import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { initializeSession } from "../../context/session";
import { executeTodoWrite } from "./todo-write";

const testDir = join(process.cwd(), ".cea");

describe("executeTodoWrite", () => {
  beforeEach(async () => {
    initializeSession();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore if directory doesn't exist
    }
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Cleanup - ignore errors
    }
  });

  test("creates todo list with multiple tasks", async () => {
    const result = await executeTodoWrite({
      todos: [
        {
          id: "1",
          content: "First task",
          status: "pending",
          priority: "high",
        },
        {
          id: "2",
          content: "Second task",
          status: "in_progress",
          priority: "medium",
        },
      ],
    });

    expect(result).toContain("OK - updated todo list");
    expect(result).toContain("total: 2 tasks");
    expect(result).toContain("pending: 1");
    expect(result).toContain("in_progress: 1");
  });

  test("handles empty todo list", async () => {
    const result = await executeTodoWrite({
      todos: [],
    });

    expect(result).toContain("OK - updated todo list");
    expect(result).toContain("total: 0 tasks");
  });

  test("includes task descriptions in output", async () => {
    const result = await executeTodoWrite({
      todos: [
        {
          id: "1",
          content: "Task with description",
          status: "pending",
          priority: "high",
          description: "Detailed description here",
        },
      ],
    });

    expect(result).toContain("Task with description");
    expect(result).toContain("Detailed description here");
  });

  test("rejects empty content", () => {
    expect(
      executeTodoWrite({
        todos: [
          {
            id: "1",
            content: "",
            status: "pending",
            priority: "high",
          },
        ],
      })
    ).rejects.toThrow('Todo item with id "1" has empty content');
  });
});
