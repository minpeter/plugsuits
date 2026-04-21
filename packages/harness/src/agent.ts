/**
 * @module agent
 * Core agent factory for the harness package.
 */

import { streamText, tool } from "ai";
import { AgentError, AgentErrorCode } from "./errors";
import type { AgentExecutionContext } from "./execution-context";
import { resolveMCPOption } from "./mcp-init";
import type { ToolDefinition, ToolSource } from "./tool-source";
import type {
  Agent,
  AgentConfig,
  AgentGuardrails,
  AgentPrepareStepContext,
  AgentPrepareStepResult,
  AgentStreamOptions,
  AgentStreamResult,
  ToolCallPart,
} from "./types";

export interface StopConditionInput {
  steps: Array<{
    toolCalls?: ToolCallPart[];
  }>;
}
export type StopCondition = (input: StopConditionInput) => boolean;

const toToolSet = async (toolSources: ToolSource[] | undefined) => {
  if (!toolSources || toolSources.length === 0) {
    return {};
  }

  const entries = await Promise.all(
    toolSources.map(async (source) => {
      const definitions = await source.listTools();
      return definitions.map(
        (definition) =>
          [
            definition.name,
            createToolFromDefinition(source, definition),
          ] as const
      );
    })
  );

  return Object.fromEntries(entries.flat());
};

const createToolFromDefinition = (
  source: ToolSource,
  definition: ToolDefinition
) =>
  tool({
    description: definition.description,
    inputSchema: definition.parameters as never,
    execute: async (args, context) =>
      source.callTool(definition.name, args, {
        abortSignal: context.abortSignal,
        experimentalContext: context.experimental_context as
          | AgentExecutionContext
          | undefined,
        messages: context.messages,
        toolCallId: context.toolCallId,
        toolName: definition.name,
      }),
  });

const mergeProviderOptions = (
  defaults: AgentStreamOptions["providerOptions"] | undefined,
  overrides: AgentStreamOptions["providerOptions"]
): AgentStreamOptions["providerOptions"] => {
  if (!(defaults && overrides)) {
    return overrides ?? defaults;
  }

  return {
    ...(defaults as Record<string, unknown>),
    ...(overrides as Record<string, unknown>),
  } as AgentStreamOptions["providerOptions"];
};

const buildBaseStreamOptions = (
  config: AgentConfig,
  opts: AgentStreamOptions
): AgentPrepareStepContext => {
  const resolvedSystem =
    opts.system ??
    config.streamDefaults?.system ??
    (typeof config.instructions === "string" ? config.instructions : undefined);

  return {
    ...config.streamDefaults,
    ...opts,
    providerOptions: mergeProviderOptions(
      config.streamDefaults?.providerOptions,
      opts.providerOptions
    ),
    system: resolvedSystem,
    model: config.model,
  };
};

const applyPreparedOverrides = (
  base: AgentPrepareStepContext,
  prepared: AgentPrepareStepResult | undefined
): AgentStreamOptions => ({
  ...base,
  ...prepared,
  messages: prepared?.messages ?? base.messages,
  providerOptions: mergeProviderOptions(
    base.providerOptions,
    prepared?.providerOptions
  ),
});

const createStreamTextResult = (
  config: AgentConfig,
  preparedOptions: AgentStreamOptions
) =>
  streamText({
    model: config.model,
    tools: config.tools,
    system: preparedOptions.system,
    messages: preparedOptions.messages,
    providerOptions: preparedOptions.providerOptions,
    maxOutputTokens: preparedOptions.maxOutputTokens,
    seed: preparedOptions.seed,
    stopWhen: [
      config.guardrails
        ? createGuardedStopCondition(config.guardrails)
        : textResponseReceived(),
      ...(config.maxStepsPerTurn === undefined
        ? []
        : [createStepCountStopCondition(config.maxStepsPerTurn)]),
      ...(config.extraStopConditions ?? []),
    ],
    temperature: preparedOptions.temperature,
    abortSignal: preparedOptions.abortSignal,
    experimental_context: preparedOptions.experimentalContext,
    experimental_repairToolCall: config.experimental_repairToolCall,
  });

const serializeToolCall = (
  toolCall: Pick<ToolCallPart, "input" | "toolName">
) => JSON.stringify({ input: toolCall.input, toolName: toolCall.toolName });

const textResponseReceived =
  (): StopCondition =>
  ({ steps }: StopConditionInput) => {
    const lastStep = steps.at(-1);
    if (!lastStep) {
      return false;
    }
    const hasTools = (lastStep.toolCalls?.length ?? 0) > 0;
    return !hasTools;
  };

const createGuardedStopCondition =
  (guardrails: AgentGuardrails): StopCondition =>
  ({ steps }: StopConditionInput) => {
    const lastStep = steps.at(-1);
    if (!lastStep) {
      return false;
    }

    const lastStepToolCalls = lastStep.toolCalls ?? [];
    if (lastStepToolCalls.length === 0) {
      return true;
    }

    const maxToolCalls = guardrails.maxToolCallsPerTurn ?? 50;
    const totalToolCalls = steps.reduce(
      (sum: number, step) => sum + (step.toolCalls?.length ?? 0),
      0
    );
    if (totalToolCalls >= maxToolCalls) {
      throw new AgentError(
        AgentErrorCode.MAX_TOOL_CALLS,
        `Exceeded maxToolCallsPerTurn (${maxToolCalls})`
      );
    }

    const threshold = guardrails.repeatedToolCallThreshold ?? 3;
    if (threshold > 0) {
      const flattenedToolCalls = steps.flatMap((step) => step.toolCalls ?? []);
      if (flattenedToolCalls.length >= threshold) {
        const recentSequence = flattenedToolCalls.slice(-threshold);
        const firstCall = recentSequence[0];
        const repeatedSignature = serializeToolCall(firstCall);
        const isRepeated = recentSequence.every(
          (toolCall) => serializeToolCall(toolCall) === repeatedSignature
        );

        if (isRepeated) {
          throw new AgentError(
            AgentErrorCode.REPEATED_TOOL_CALL,
            `Detected repeated tool call ${threshold} times in a row: ${firstCall.toolName}`
          );
        }
      }
    }

    return false;
  };

const createStepCountStopCondition =
  (maxStepsPerTurn: number): StopCondition =>
  ({ steps }) =>
    steps.length >= maxStepsPerTurn;

/**
 * Creates an {@link Agent} instance that wraps a Vercel AI SDK `streamText` call.
 *
 * @param config - Agent configuration including model, tools, and instructions.
 * @returns An `Agent` object with a `stream()` method for initiating a single turn.
 *
 * @example
 * ```typescript
 * const agent = await createAgent({
 *   model: openai('gpt-4o'),
 *   instructions: 'You are a helpful assistant.',
 *   tools: { get_time: tool({ ... }) },
 * });
 * ```
 */
export async function createAgent(config: AgentConfig): Promise<Agent> {
  let mergedTools = {
    ...(config.tools ?? {}),
    ...(await toToolSet(config.toolSources)),
  };
  let closeFn: () => Promise<void> = async () => {
    await Promise.all(
      config.toolSources?.map((source) => source.close?.()) ?? []
    );
  };

  if (config.mcp !== undefined) {
    const resolved = await resolveMCPOption(config.mcp, mergedTools);
    mergedTools = resolved.tools;
    const previousClose = closeFn;
    closeFn = async () => {
      try {
        await resolved.close();
      } finally {
        await previousClose();
      }
    };
  }

  const effectiveConfig: AgentConfig =
    mergedTools === config.tools ? config : { ...config, tools: mergedTools };

  return {
    config: effectiveConfig,
    close: closeFn,
    /**
     * Initiates a single streaming turn with the given messages.
     * Returns a result object with `fullStream`, `finishReason`, and `response`.
     */
    stream(opts: AgentStreamOptions): AgentStreamResult {
      const baseOptions = buildBaseStreamOptions(effectiveConfig, opts);
      const prepared = effectiveConfig.prepareStep?.(baseOptions);
      const result = createStreamTextResult(
        effectiveConfig,
        applyPreparedOverrides(baseOptions, prepared)
      );

      const { finishReason, response, usage, totalUsage } = result;

      const swallow = () => undefined;
      finishReason.then(undefined, swallow);
      response.then(undefined, swallow);
      usage.then(undefined, swallow);
      totalUsage.then(undefined, swallow);

      return {
        finishReason,
        fullStream: result.fullStream,
        response,
        usage,
        totalUsage,
      };
    },
  };
}
