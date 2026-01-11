import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { TODO_DIR } from "../context/paths";
import { getSessionId, hasActiveSession } from "../context/session";

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
  description?: string;
}

interface TodoData {
  todos: TodoItem[];
  updatedAt: string;
}

export async function getIncompleteTodos(): Promise<TodoItem[]> {
  if (!hasActiveSession()) {
    return [];
  }

  const sessionId = getSessionId();
  const todoPath = join(process.cwd(), TODO_DIR, `${sessionId}.json`);

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

  return data.todos.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled"
  );
}

export function buildTodoContinuationPrompt(todos: TodoItem[]): string {
  const statusEmojiMap: Record<string, string> = {
    in_progress: "🔄",
    pending: "📋",
    completed: "✅",
    cancelled: "❌",
  };

  const taskList = todos
    .map((t, i) => {
      const statusEmoji = statusEmojiMap[t.status] ?? "⚠️";
      return `${i + 1}. ${statusEmoji} [${t.status.toUpperCase()}] ${t.content} (priority: ${t.priority})`;
    })
    .join("\n");

  return `

---

[SYSTEM REMINDER - TODO CONTINUATION]

You have an active todo list with ${todos.length} incomplete task(s):

${taskList}

CRITICAL EXECUTION RULES - READ CAREFULLY:

1. EXECUTE TASKS, DO NOT JUST DESCRIBE THEM
   - DO NOT tell the user to run commands manually
   - YOU must call shell_execute to run commands
   - YOU must call write_file/edit_file to modify files
   - DO NOT wait for user to do the work - YOU do it

2. CONTINUOUS EXECUTION:
   - Mark task as in_progress using todo_write
   - Execute the task using appropriate tools (shell_execute, write_file, etc.)
   - Mark as completed using todo_write
   - IMMEDIATELY start next task without stopping
   - DO NOT ask user if ready - just continue

3. Tool Usage:
   - For git commands: USE shell_execute
   - For file changes: USE write_file or edit_file
   - For running tests: USE shell_execute
   - DO NOT tell user to run commands - YOU run them

4. Continue until COMPLETE:
   - Process ALL tasks in sequence
   - Only stop when ALL tasks are marked completed
   - Do NOT wait for user confirmation between tasks

You are autonomous. Execute tasks, do not just describe them.

---
`.trim();
}
