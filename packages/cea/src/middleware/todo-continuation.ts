import type { TodoItem } from "@ai-sdk-tool/harness";
import { SessionManager, TodoContinuation } from "@ai-sdk-tool/harness";
import { TODO_DIR } from "../context/paths";

export type { TodoItem } from "@ai-sdk-tool/harness";

const sessionManager =
  (globalThis as typeof globalThis & { __ceaSessionManager?: SessionManager })
    .__ceaSessionManager ?? new SessionManager();

const STATUS_EMOJI: Record<string, string> = {
  in_progress: "🔄",
  pending: "📋",
  completed: "✅",
  cancelled: "❌",
};

function ceaPromptTemplate(todos: TodoItem[]): string {
  const taskList = todos
    .map((t, i) => {
      const emoji = STATUS_EMOJI[t.status] ?? "⚠️";
      return `${i + 1}. ${emoji} [${t.status.toUpperCase()}] ${t.content} (priority: ${t.priority})`;
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

---`.trim();
}

function ceaUserMessageTemplate(todos: TodoItem[]): string {
  const taskList = todos
    .map((t, i) => {
      const emoji = STATUS_EMOJI[t.status] ?? "⚠️";
      return `${i + 1}. ${emoji} [${t.status.toUpperCase()}] ${t.content} (priority: ${t.priority})`;
    })
    .join("\n");

  return [
    "[SYSTEM REMINDER - TODO CONTINUATION]",
    "",
    `You have ${todos.length} incomplete task(s):`,
    "",
    taskList,
    "",
    "Continue executing the tasks now. Update statuses with todo_write.",
    "Do not stop until all tasks are completed.",
  ]
    .join("\n")
    .trim();
}

const todoContinuation = new TodoContinuation(
  {
    todoDir: TODO_DIR,
    promptTemplate: ceaPromptTemplate,
    userMessageTemplate: ceaUserMessageTemplate,
  },
  sessionManager
);

export const getIncompleteTodos = () => todoContinuation.getIncompleteTodos();
export const buildTodoContinuationPrompt = (todos: TodoItem[]) =>
  todoContinuation.buildContinuationPrompt(todos);
export const buildTodoContinuationUserMessage = (todos: TodoItem[]) =>
  todoContinuation.buildContinuationUserMessage(todos);
