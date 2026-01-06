import type { TextStreamPart } from "ai";
import {
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
} from "ai";
import { env } from "./env";
import { SYSTEM_PROMPT } from "./prompts/system";
import type { tools } from "./tools/index";
import { tools as agentTools } from "./tools/index";
import {
  colorize,
  printAIPrefix,
  printChunk,
  printNewline,
  printReasoningChunk,
  printReasoningEnd,
  printReasoningPrefix,
  printTool,
} from "./utils/colors";
import { compactConversation } from "./utils/context-compactor";
import {
  type ContextConfig,
  type ContextStats,
  ContextTracker,
} from "./utils/context-tracker";
import { withRetry } from "./utils/retry";

type StreamChunk = TextStreamPart<typeof tools>;

interface StreamState {
  hasStartedText: boolean;
  hasStartedReasoning: boolean;
}

function endReasoningIfNeeded(state: StreamState): void {
  if (state.hasStartedReasoning) {
    printReasoningEnd();
    state.hasStartedReasoning = false;
  }
}

function endTextIfNeeded(state: StreamState): void {
  if (state.hasStartedText) {
    printNewline();
    state.hasStartedText = false;
  }
}

function handleReasoningDelta(chunk: StreamChunk, state: StreamState): void {
  if (chunk.type !== "reasoning-delta") {
    return;
  }
  if (!state.hasStartedReasoning) {
    printReasoningPrefix();
    state.hasStartedReasoning = true;
  }
  printReasoningChunk(chunk.text);
}

function handleTextDelta(chunk: StreamChunk, state: StreamState): void {
  if (chunk.type !== "text-delta") {
    return;
  }
  endReasoningIfNeeded(state);
  if (!state.hasStartedText) {
    printAIPrefix();
    state.hasStartedText = true;
  }
  printChunk(chunk.text);
}

function handleToolCall(chunk: StreamChunk, state: StreamState): void {
  if (chunk.type !== "tool-call") {
    return;
  }
  endReasoningIfNeeded(state);
  endTextIfNeeded(state);
  printTool(chunk.toolName, chunk.input);
}

function logDebugChunk(chunk: StreamChunk, chunkCount: number): void {
  const skipTypes = ["text-delta", "reasoning-delta", "tool-result"];
  if (!skipTypes.includes(chunk.type)) {
    console.log(`[DEBUG] #${chunkCount} type: ${chunk.type}`);
  }
}

function logDebugError(chunk: StreamChunk): void {
  if (chunk.type === "error") {
    console.log("[DEBUG] Error:", chunk.error);
  }
}

function logDebugFinish(chunk: StreamChunk): void {
  if (chunk.type === "finish") {
    console.log(`[DEBUG] Finish reason: ${chunk.finishReason}`);
  }
}

const DEFAULT_MAX_STEPS = 255;

export interface AgentConfig {
  maxSteps?: number;
  contextConfig?: Partial<ContextConfig>;
  autoCompact?: boolean;
}

export class Agent {
  private model: LanguageModel;
  private conversation: ModelMessage[] = [];
  private readonly maxSteps: number;
  private readonly contextTracker: ContextTracker;
  private readonly autoCompact: boolean;
  private abortController: AbortController | null = null;

  constructor(model: LanguageModel, config: AgentConfig = {}) {
    this.model = model;
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
    this.contextTracker = new ContextTracker(config.contextConfig);
    this.autoCompact = config.autoCompact ?? true;
  }

  isRunning(): boolean {
    return this.abortController !== null;
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  getModel(): LanguageModel {
    return this.model;
  }

  setModel(model: LanguageModel): void {
    this.model = model;
  }

  getConversation(): ModelMessage[] {
    return [...this.conversation];
  }

  loadConversation(messages: ModelMessage[]): void {
    this.conversation = [...messages];
  }

  clearConversation(): void {
    this.conversation = [];
    this.contextTracker.reset();
  }

  /**
   * Set the maximum context tokens for the current model
   */
  setMaxContextTokens(tokens: number): void {
    this.contextTracker.setMaxContextTokens(tokens);
  }

  /**
   * Set the compaction threshold (0.0 - 1.0)
   */
  setCompactionThreshold(threshold: number): void {
    this.contextTracker.setCompactionThreshold(threshold);
  }

  /**
   * Get current context usage statistics
   */
  getContextStats(): ContextStats {
    return this.contextTracker.getStats();
  }

  /**
   * Manually trigger context compaction
   */
  async compactContext(): Promise<void> {
    const result = await compactConversation(this.model, this.conversation);
    this.conversation = result.messages;
    // Estimate new token count (rough approximation)
    const estimatedTokens = result.summary.length / 4; // ~4 chars per token
    this.contextTracker.afterCompaction(estimatedTokens);
  }

  async chat(userInput: string): Promise<{ aborted: boolean }> {
    if (this.autoCompact && this.contextTracker.shouldCompact()) {
      await this.compactContext();
    }

    this.conversation.push({
      role: "user",
      content: userInput,
    });

    this.abortController = new AbortController();

    try {
      await withRetry(async () => {
        await this.executeStreamingChat();
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { aborted: true };
      }
      throw error;
    } finally {
      this.abortController = null;
    }

    if (this.autoCompact && this.contextTracker.shouldCompact()) {
      await this.compactContext();
    }

    return { aborted: false };
  }

  private async executeStreamingChat(): Promise<void> {
    const result = streamText({
      model: this.model,
      system: SYSTEM_PROMPT,
      messages: this.conversation,
      tools: agentTools,
      stopWhen: stepCountIs(this.maxSteps),
      abortSignal: this.abortController?.signal,
      providerOptions: {
        friendliai: {
          chat_template_kwargs: {
            enable_thinking: true,
          },
        },
      },
    });

    const state: StreamState = {
      hasStartedText: false,
      hasStartedReasoning: false,
    };

    let chunkCount = 0;
    const debug = env.DEBUG_CHUNK_LOG;

    let aborted = false;

    try {
      for await (const chunk of result.fullStream) {
        if (this.abortController?.signal.aborted) {
          aborted = true;
          break;
        }

        chunkCount++;

        if (debug) {
          logDebugChunk(chunk, chunkCount);
          logDebugError(chunk);
          logDebugFinish(chunk);
        }

        handleReasoningDelta(chunk, state);
        handleTextDelta(chunk, state);
        handleToolCall(chunk, state);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        aborted = true;
      } else {
        throw error;
      }
    }

    endReasoningIfNeeded(state);
    endTextIfNeeded(state);

    if (aborted) {
      console.log(colorize("yellow", "\n[Interrupted by user]"));
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      throw abortError;
    }

    const response = await result.response;

    // Update context tracker with usage information
    const totalUsage = await result.totalUsage;
    if (totalUsage) {
      this.contextTracker.updateUsage(totalUsage);

      if (debug) {
        const stats = this.contextTracker.getStats();
        console.log(
          colorize(
            "dim",
            `[Context] ${stats.totalTokens.toLocaleString()} / ${stats.maxContextTokens.toLocaleString()} tokens (${(stats.usagePercentage * 100).toFixed(1)}%)`
          )
        );
      }
    }

    if (debug) {
      console.log(`[DEBUG] Total chunks: ${chunkCount}`);
      console.log(`[DEBUG] Response messages: ${response.messages.length}`);
    }
    this.conversation.push(...response.messages);
  }
}
