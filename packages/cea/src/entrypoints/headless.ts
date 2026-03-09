#!/usr/bin/env bun

import { MessageHistory, SessionManager } from "@ai-sdk-tool/harness";
import type { TrajectoryEvent } from "@ai-sdk-tool/headless";
import {
  emitEvent,
  registerSignalHandlers,
  runHeadless,
} from "@ai-sdk-tool/headless";
import type { ModelMessage } from "ai";
import { agentManager } from "../agent";
import { translateToEnglish } from "../context/translation";
import { validateProviderConfig } from "../env";
import {
  buildTodoContinuationUserMessage,
  getIncompleteTodos,
} from "../middleware/todo-continuation";
import { cleanup } from "../tools/utils/execute/process-manager";
import { initializeTools } from "../utils/tools-manager";
import { applyHeadlessAgentConfig } from "./headless-agent-config";
import { parseArgs } from "./headless-args";

const globalSessionState = globalThis as typeof globalThis & {
  __ceaSessionManager?: SessionManager;
};

if (!globalSessionState.__ceaSessionManager) {
  globalSessionState.__ceaSessionManager = new SessionManager();
}

const sessionId = globalSessionState.__ceaSessionManager.initialize();
const startedAt = Date.now();
const timestamp = (): string => new Date().toISOString();

const exitWithCleanup = (code: number): never => {
  cleanup(true);
  process.exit(code);
};

const emit = (event: TrajectoryEvent): void => {
  emitEvent(event);
};

registerSignalHandlers({ onCleanup: cleanup, onFatalCleanup: exitWithCleanup });

const run = async (): Promise<void> => {
  validateProviderConfig();
  await initializeTools();

  const {
    prompt,
    model,
    provider,
    reasoningMode,
    toolFallbackMode,
    translateUserPrompts,
    maxIterations,
  } = parseArgs();

  applyHeadlessAgentConfig(agentManager, {
    model,
    provider,
    reasoningMode,
    toolFallbackMode,
    translateUserPrompts,
  });

  const messageHistory = new MessageHistory({
    compaction: agentManager.buildCompactionConfig(),
  });
  const preparedPrompt = agentManager.isTranslationEnabled()
    ? await translateToEnglish(prompt, agentManager)
    : { translated: false, text: prompt };

  emit({ timestamp: timestamp(), type: "user", sessionId, content: prompt });
  if (preparedPrompt.error) {
    emit({
      timestamp: timestamp(),
      type: "error",
      sessionId,
      error: `[translation] Failed to translate input: ${preparedPrompt.error}. Using original text.`,
    });
  }

  messageHistory.addUserMessage(
    preparedPrompt.text,
    preparedPrompt.originalText
  );

  try {
    await runHeadless({
      sessionId,
      emitEvent,
      getModelId: () => agentManager.getModelId(),
      maxIterations,
      messageHistory,
      onTodoReminder: async () => {
        const incompleteTodos = await getIncompleteTodos();
        if (incompleteTodos.length === 0) {
          return { hasReminder: false, message: null };
        }

        return {
          hasReminder: true,
          message: buildTodoContinuationUserMessage(incompleteTodos),
        };
      },
      stream: (messages: unknown[]) =>
        agentManager.stream(messages as ModelMessage[]),
    });
  } catch (error) {
    emit({
      timestamp: timestamp(),
      type: "error",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    exitWithCleanup(1);
  }

  cleanup();
  console.error(
    `[headless] Completed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s`
  );
};

run().catch((error: unknown) => {
  console.error("Fatal error:", error);
  exitWithCleanup(1);
});
