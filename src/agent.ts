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
import {
  measureContextTokens,
  type RenderApiOptions,
} from "./utils/render-api";
import { withRetry } from "./utils/retry";

type StreamChunk = TextStreamPart<typeof tools>;
type ToolCallChunk = Extract<StreamChunk, { type: "tool-call" }>;
type AssistantContentPart = { type: "text"; text: string } | ToolCallChunk;

interface StreamState {
  hasStartedText: boolean;
  hasStartedReasoning: boolean;
  sawTextDelta: boolean;
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
  state.sawTextDelta = true;
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

function appendAssistantText(
  parts: AssistantContentPart[],
  text: string
): void {
  const lastPart = parts.at(-1);
  if (lastPart && lastPart.type === "text") {
    lastPart.text += text;
    return;
  }
  parts.push({ type: "text", text });
}

function appendAssistantToolCall(
  parts: AssistantContentPart[],
  toolCall: ToolCallChunk
): void {
  parts.push(toolCall);
}

function flushAssistantMessage(
  stagedMessages: ModelMessage[],
  parts: AssistantContentPart[]
): void {
  if (parts.length === 0) {
    return;
  }
  stagedMessages.push({
    role: "assistant",
    content: [...parts],
  });
  parts.length = 0;
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

function extractAssistantText(messages: ModelMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      if (message.content) {
        chunks.push(message.content);
      }
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text" && part.text) {
          chunks.push(part.text);
        }
      }
    }
  }
  return chunks.join("");
}

function assistantMessageHasText(message: ModelMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }
  if (Array.isArray(message.content)) {
    return message.content.some(
      (part) => part.type === "text" && (part.text ?? "").trim().length > 0
    );
  }
  return false;
}

function shouldContinueAfterTools(messages: ModelMessage[]): boolean {
  let lastToolIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "tool") {
      lastToolIndex = i;
    }
  }
  if (lastToolIndex === -1) {
    return false;
  }
  for (let i = lastToolIndex + 1; i < messages.length; i += 1) {
    if (assistantMessageHasText(messages[i])) {
      return false;
    }
  }
  return true;
}

const MAX_TOOL_FOLLOWUPS = 3;

const DEFAULT_MAX_STEPS = 255;

export interface AgentConfig {
  maxSteps?: number;
  contextConfig?: Partial<ContextConfig>;
  autoCompact?: boolean;
  modelId?: string;
}

export class Agent {
  private model: LanguageModel;
  private modelId: string;
  private conversation: ModelMessage[] = [];
  private readonly maxSteps: number;
  private readonly contextTracker: ContextTracker;
  private readonly autoCompact: boolean;
  private abortController: AbortController | null = null;
  private contextMeasureInFlight: Promise<number | null> | null = null;
  private readonly pendingContextMeasures: Array<
    RenderApiOptions & {
      debugLabel?: string;
      messages?: ModelMessage[];
      systemPrompt?: string;
    }
  > = [];

  constructor(model: LanguageModel, config: AgentConfig = {}) {
    this.model = model;
    this.modelId = config.modelId ?? "";
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

  setModel(model: LanguageModel, modelId?: string): void {
    this.model = model;
    if (modelId) {
      this.modelId = modelId;
    }
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

  getContextConfig(): ContextConfig {
    return this.contextTracker.getConfig();
  }

  async refreshContextTokens(
    options: RenderApiOptions & {
      debugLabel?: string;
      messages?: ModelMessage[];
      systemPrompt?: string;
    } = {}
  ): Promise<number | null> {
    if (!this.modelId) {
      options.onError?.("Model ID is not set for context measurement.");
      return null;
    }

    const { messages, debugLabel, systemPrompt, ...renderOptions } = options;
    const prompt = systemPrompt ?? SYSTEM_PROMPT;
    let tokenCount: number | null = null;
    try {
      tokenCount = await measureContextTokens(
        messages ?? this.conversation,
        this.modelId,
        prompt,
        renderOptions
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onError?.(`Context measurement failed: ${message}`);
      return null;
    }

    if (tokenCount !== null) {
      this.contextTracker.setContextTokens(tokenCount);
      this.logContextStats(debugLabel);
    }

    return tokenCount;
  }

  private logContextStats(label?: string): void {
    if (!env.DEBUG_CONTEXT_LOG) {
      return;
    }
    const stats = this.contextTracker.getStats();
    const suffix = label ? ` ${label}` : "";
    const status = stats.shouldCompact
      ? colorize("yellow", "COMPACT")
      : colorize("green", "OK");
    console.log(
      colorize("dim", `[Context${suffix}]`) +
        " " +
        `${stats.totalTokens.toLocaleString()} / ${stats.maxContextTokens.toLocaleString()} tokens ` +
        `(${(stats.usagePercentage * 100).toFixed(1)}%) | ` +
        `compact: ${status}`
    );
  }

  scheduleContextMeasurement(
    options: RenderApiOptions & {
      debugLabel?: string;
      messages?: ModelMessage[];
      systemPrompt?: string;
    } = {}
  ): void {
    const scheduledOptions = options.messages
      ? { ...options, messages: [...options.messages] }
      : options;

    if (this.contextMeasureInFlight) {
      this.pendingContextMeasures.push(scheduledOptions);
      return;
    }

    this.contextMeasureInFlight = this.refreshContextTokens(scheduledOptions)
      .catch(() => null)
      .finally(() => {
        this.contextMeasureInFlight = null;
        const pending = this.pendingContextMeasures.shift();
        if (pending) {
          this.scheduleContextMeasurement(pending);
        }
      });
  }

  async flushContextMeasurement(): Promise<number | null> {
    while (
      this.contextMeasureInFlight ||
      this.pendingContextMeasures.length > 0
    ) {
      if (this.contextMeasureInFlight) {
        await this.contextMeasureInFlight;
        continue;
      }
      const pending = this.pendingContextMeasures.shift();
      if (pending) {
        this.scheduleContextMeasurement(pending);
      }
    }

    return this.contextTracker.getStats().totalTokens;
  }

  /**
   * Manually trigger context compaction
   */
  async compactContext(): Promise<void> {
    const result = await compactConversation(this.model, this.conversation);
    this.conversation = result.messages;

    const tokenCount = await this.refreshContextTokens({
      debugLabel: "after compact",
    });
    if (tokenCount !== null) {
      this.contextTracker.afterCompaction(tokenCount);
      return;
    }
    const estimatedTokens = Math.round(result.summary.length / 4);
    this.contextTracker.afterCompaction(estimatedTokens);
  }

  async chat(userInput: string): Promise<{ aborted: boolean }> {
    this.conversation.push({ role: "user", content: userInput });
    await this.refreshContextTokens({ debugLabel: "after user" });

    if (this.autoCompact && this.contextTracker.shouldCompact()) {
      await this.compactContext();
    }

    this.abortController = new AbortController();

    try {
      await withRetry(async () => {
        await this.executeStreamingChat(SYSTEM_PROMPT, this.conversation);
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { aborted: true };
      }
      throw error;
    } finally {
      this.abortController = null;
    }

    this.scheduleContextMeasurement({ debugLabel: "after ai" });
    await this.flushContextMeasurement();

    if (this.autoCompact && this.contextTracker.shouldCompact()) {
      await this.compactContext();
    }

    return { aborted: false };
  }

  private handleStreamChunk(
    chunk: StreamChunk,
    state: StreamState,
    stagedMessages: ModelMessage[],
    assistantParts: AssistantContentPart[],
    systemPrompt: string
  ): void {
    if (chunk.type === "text-delta") {
      appendAssistantText(assistantParts, chunk.text);
    }

    if (chunk.type === "tool-call") {
      appendAssistantToolCall(assistantParts, chunk);
    }

    if (chunk.type === "tool-result") {
      flushAssistantMessage(stagedMessages, assistantParts);
      const toolMessage: ModelMessage = {
        role: "tool",
        content: [chunk],
      };
      stagedMessages.push(toolMessage);
      this.scheduleContextMeasurement({
        debugLabel: "after tool",
        messages: stagedMessages,
        systemPrompt,
      });
    }

    handleReasoningDelta(chunk, state);
    handleTextDelta(chunk, state);
    handleToolCall(chunk, state);
  }

  private async runStreamingStep(
    systemPrompt: string,
    messages: ModelMessage[]
  ): Promise<ModelMessage[]> {
    const result = streamText({
      model: this.model,
      system: systemPrompt,
      messages,
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
      sawTextDelta: false,
    };

    const stagedMessages: ModelMessage[] = [...messages];
    const assistantParts: AssistantContentPart[] = [];

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

        this.handleStreamChunk(
          chunk,
          state,
          stagedMessages,
          assistantParts,
          systemPrompt
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        aborted = true;
      } else {
        throw error;
      }
    }

    flushAssistantMessage(stagedMessages, assistantParts);
    endReasoningIfNeeded(state);
    endTextIfNeeded(state);

    if (aborted) {
      console.log(colorize("yellow", "\n[Interrupted by user]"));
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      throw abortError;
    }

    const response = await result.response;

    // Update context tracker with usage information (fallback for estimation).
    const totalUsage = await result.totalUsage;
    if (totalUsage) {
      this.contextTracker.updateUsage(totalUsage);
    }

    if (debug) {
      console.log(`[DEBUG] Total chunks: ${chunkCount}`);
      console.log(`[DEBUG] Response messages: ${response.messages.length}`);
    }
    if (!state.sawTextDelta) {
      const fallbackText = extractAssistantText(response.messages);
      if (fallbackText) {
        printAIPrefix();
        printChunk(fallbackText);
        printNewline();
      }
    }

    return response.messages;
  }

  private async executeStreamingChat(
    systemPrompt: string,
    messages: ModelMessage[]
  ): Promise<void> {
    let currentMessages = messages;

    for (let attempt = 0; attempt < MAX_TOOL_FOLLOWUPS; attempt += 1) {
      const responseMessages = await this.runStreamingStep(
        systemPrompt,
        currentMessages
      );
      this.conversation.push(...responseMessages);

      if (!shouldContinueAfterTools(responseMessages)) {
        return;
      }

      currentMessages = this.conversation;
    }
  }
}
