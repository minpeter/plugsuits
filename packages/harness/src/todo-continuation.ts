import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionManager } from "./session.js";

export interface TodoItem {
  content: string;
  description?: string;
  id: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

interface TodoData {
  todos: TodoItem[];
  updatedAt: string;
}

export interface TodoConfig {
  promptTemplate?: (todos: TodoItem[]) => string;
  todoDir: string;
  userMessageTemplate?: (todos: TodoItem[]) => string;
}

const STATUS_EMOJI_MAP: Record<TodoItem["status"], string> = {
  in_progress: "🔄",
  pending: "📋",
  completed: "✅",
  cancelled: "❌",
};

function buildTodoTaskList(todos: TodoItem[]): string {
  return todos
    .map((t, i) => {
      const statusEmoji = STATUS_EMOJI_MAP[t.status] ?? "⚠️";
      return `${i + 1}. ${statusEmoji} [${t.status.toUpperCase()}] ${t.content} (priority: ${t.priority})`;
    })
    .join("\n");
}

function defaultPromptTemplate(todos: TodoItem[]): string {
  const taskList = buildTodoTaskList(todos);
  return `

---

[SYSTEM REMINDER - TODO CONTINUATION]

You have an active todo list with ${todos.length} incomplete task(s):

${taskList}

Continue executing the tasks now. Update statuses as you go.
Only stop when ALL tasks are completed.

---`.trim();
}

function defaultUserMessageTemplate(todos: TodoItem[]): string {
  const taskList = buildTodoTaskList(todos);
  return [
    "[SYSTEM REMINDER - TODO CONTINUATION]",
    "",
    `You have ${todos.length} incomplete task(s):`,
    "",
    taskList,
    "",
    "Continue executing the tasks now.",
    "Do not stop until all tasks are completed.",
  ]
    .join("\n")
    .trim();
}

export class TodoContinuation {
  private readonly config: TodoConfig;
  private readonly sessionManager: SessionManager;

  constructor(config: TodoConfig, sessionManager: SessionManager) {
    this.config = config;
    this.sessionManager = sessionManager;
  }

  async getIncompleteTodos(): Promise<TodoItem[]> {
    if (!this.sessionManager.isActive()) {
      return [];
    }

    const sessionId = this.sessionManager.getId();
    const todoPath = join(
      process.cwd(),
      this.config.todoDir,
      `${sessionId}.json`
    );

    try {
      await stat(todoPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    let data: TodoData;
    try {
      const content = await readFile(todoPath, "utf-8");
      data = JSON.parse(content);
    } catch {
      return [];
    }

    if (!Array.isArray(data.todos)) {
      return [];
    }

    return data.todos.filter(
      (t) => t.status !== "completed" && t.status !== "cancelled"
    );
  }

  buildContinuationPrompt(todos: TodoItem[]): string {
    const fn = this.config.promptTemplate ?? defaultPromptTemplate;
    return fn(todos);
  }

  buildContinuationUserMessage(todos: TodoItem[]): string {
    const fn = this.config.userMessageTemplate ?? defaultUserMessageTemplate;
    return fn(todos);
  }
}
