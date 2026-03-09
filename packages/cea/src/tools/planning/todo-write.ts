import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@ai-sdk-tool/harness";
import { tool } from "ai";
import { z } from "zod";
import { TODO_DIR } from "../../context/paths";
import TODO_WRITE_DESCRIPTION from "./todo-write.txt";

const typedGlobalThis = globalThis as typeof globalThis & {
  __ceaSessionManager?: SessionManager;
};
if (!typedGlobalThis.__ceaSessionManager) {
  typedGlobalThis.__ceaSessionManager = new SessionManager();
}
const sessionManager = typedGlobalThis.__ceaSessionManager;

const todoItemSchema = z.object({
  id: z.string().describe("Unique identifier for the todo item"),
  content: z.string().describe("Brief description of the task"),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Current status of the task"),
  priority: z
    .enum(["high", "medium", "low"])
    .describe("Priority level of the task"),
  description: z.string().optional().describe("Detailed task description"),
});

const inputSchema = z.object({
  todos: z
    .array(todoItemSchema)
    .describe("Array of todo items for the task list"),
});

export type TodoItem = z.infer<typeof todoItemSchema>;
export type TodoWriteInput = z.infer<typeof inputSchema>;

function generateMarkdown(todos: TodoItem[]): string {
  const lines = ["# Current Task List", ""];

  const byStatus = {
    in_progress: todos.filter((t) => t.status === "in_progress"),
    pending: todos.filter((t) => t.status === "pending"),
    completed: todos.filter((t) => t.status === "completed"),
    cancelled: todos.filter((t) => t.status === "cancelled"),
  };

  if (byStatus.in_progress.length > 0) {
    lines.push("## 🔄 In Progress");
    for (const todo of byStatus.in_progress) {
      lines.push(`- [~] **${todo.content}** (${todo.priority})`);
      if (todo.description) {
        lines.push(`  ${todo.description}`);
      }
    }
    lines.push("");
  }

  if (byStatus.pending.length > 0) {
    lines.push("## 📋 Pending");
    for (const todo of byStatus.pending) {
      lines.push(`- [ ] ${todo.content} (${todo.priority})`);
      if (todo.description) {
        lines.push(`  ${todo.description}`);
      }
    }
    lines.push("");
  }

  if (byStatus.completed.length > 0) {
    lines.push("## ✅ Completed");
    for (const todo of byStatus.completed) {
      lines.push(`- [x] ${todo.content}`);
    }
    lines.push("");
  }

  if (byStatus.cancelled.length > 0) {
    lines.push("## ❌ Cancelled");
    for (const todo of byStatus.cancelled) {
      lines.push(`- [-] ${todo.content}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function cleanupStaleTodos(todoDir: string): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const entries = await readdir(todoDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = join(todoDir, entry.name);
      const fileStats = await stat(filePath);
      if (fileStats.mtimeMs < cutoff) {
        await unlink(filePath).catch(() => {
          /* ignore */
        });
      }
    }
  } catch {
    // Directory doesn't exist yet — nothing to clean
  }
}

export async function executeTodoWrite({
  todos,
}: TodoWriteInput): Promise<string> {
  // Validate content is not empty (runtime check to avoid minLength in JSON schema)
  for (const todo of todos) {
    if (!todo.content || todo.content.trim() === "") {
      throw new Error(`Todo item with id "${todo.id}" has empty content`);
    }
  }

  const sessionId = sessionManager.getId();
  const todoDir = TODO_DIR;

  await cleanupStaleTodos(todoDir);
  await mkdir(todoDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const todoData = {
    todos,
    updatedAt: timestamp,
    sessionId,
  };

  const jsonPath = join(todoDir, `${sessionId}.json`);
  await writeFile(jsonPath, JSON.stringify(todoData, null, 2), "utf-8");

  const markdown = generateMarkdown(todos);
  const mdPath = join(todoDir, `${sessionId}.md`);
  await writeFile(mdPath, markdown, "utf-8");

  const stats = {
    total: todos.length,
    completed: todos.filter((t) => t.status === "completed").length,
    inProgress: todos.filter((t) => t.status === "in_progress").length,
    pending: todos.filter((t) => t.status === "pending").length,
    cancelled: todos.filter((t) => t.status === "cancelled").length,
  };

  const output = [
    "OK - updated todo list",
    `session: ${sessionId}`,
    `path: ${TODO_DIR}/${sessionId}.json`,
    `total: ${stats.total} tasks`,
    `completed: ${stats.completed}`,
    `in_progress: ${stats.inProgress}`,
    `pending: ${stats.pending}`,
    `cancelled: ${stats.cancelled}`,
    "",
    "======== Current Task List ========",
    markdown,
    "======== end ========",
  ];

  return output.join("\n");
}

export const todoWriteTool = tool({
  description: TODO_WRITE_DESCRIPTION,
  inputSchema,
  execute: executeTodoWrite,
});
