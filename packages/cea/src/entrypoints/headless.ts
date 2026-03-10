#!/usr/bin/env bun

import { MessageHistory, SessionManager } from "@ai-sdk-tool/harness";
import type { TrajectoryEvent } from "@ai-sdk-tool/headless";
import {
  emitEvent,
  registerSignalHandlers,
  runHeadless,
} from "@ai-sdk-tool/headless";
import type { ModelMessage } from "ai";
import { defineCommand, runMain } from "citty";
import { agentManager } from "../agent";
import {
  type HeadlessArgs,
  headlessArgsDef,
  normalizeRawArgs,
  resolveHeadlessConfig,
} from "../cli-defs";
import { translateToEnglish } from "../context/translation";
import { validateProviderConfig } from "../env";
import {
  buildTodoContinuationUserMessage,
  getIncompleteTodos,
} from "../middleware/todo-continuation";
import { cleanup } from "../tools/utils/execute/process-manager";
import { initializeTools } from "../utils/tools-manager";

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

const headlessCommand = defineCommand({
  meta: {
    name: "plugsuits-headless",
    description: "Run in headless JSONL mode",
  },
  args: headlessArgsDef,
  async run({ args }) {
    validateProviderConfig();
    await initializeTools();

    const config = resolveHeadlessConfig(args as HeadlessArgs);

    agentManager.setHeadlessMode(true);
    if (config.provider) {
      agentManager.setProvider(config.provider);
    }
    if (config.model) {
      agentManager.setModelId(config.model);
    }
    if (config.reasoningMode !== null) {
      agentManager.setReasoningMode(config.reasoningMode);
    }
    agentManager.setToolFallbackMode(config.toolFallbackMode);
    agentManager.setTranslationEnabled(config.translateUserPrompts);

    const messageHistory = new MessageHistory({
      compaction: agentManager.buildCompactionConfig(),
    });
    messageHistory.setContextLimit(
      agentManager.getModelTokenLimits().contextLength
    );

    const preparedPrompt = agentManager.isTranslationEnabled()
      ? await translateToEnglish(config.prompt, agentManager)
      : { translated: false, text: config.prompt };

    emit({
      timestamp: timestamp(),
      type: "user",
      sessionId,
      content: config.prompt,
    });

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
        maxIterations: config.maxIterations,
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
  },
});

runMain(headlessCommand, { rawArgs: normalizeRawArgs(process.argv.slice(2)) });
