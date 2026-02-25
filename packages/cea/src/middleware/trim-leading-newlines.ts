import type {
  LanguageModelV3Content,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

const LEADING_NEWLINES = /^\n+/;

function trimContentLeadingNewlines(
  content: LanguageModelV3Content[]
): LanguageModelV3Content[] {
  if (content.length === 0) {
    return content;
  }

  const first = content[0];
  if (first.type === "text") {
    const trimmed = first.text.replace(LEADING_NEWLINES, "");
    if (trimmed === first.text) {
      return content;
    }
    return [{ ...first, text: trimmed }, ...content.slice(1)];
  }
  return content;
}

export const trimLeadingNewlinesMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    return {
      ...result,
      content: trimContentLeadingNewlines(result.content),
    };
  },

  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();

    let hasTrimmed = false;

    const transformStream = new TransformStream<
      LanguageModelV3StreamPart,
      LanguageModelV3StreamPart
    >({
      transform(chunk, controller) {
        if (chunk.type === "text-delta" && !hasTrimmed) {
          const trimmed = chunk.delta.replace(LEADING_NEWLINES, "");
          if (trimmed !== "" || chunk.delta === "") {
            hasTrimmed = true;
          }
          if (trimmed !== "") {
            controller.enqueue({ ...chunk, delta: trimmed });
          }
          return;
        }
        controller.enqueue(chunk);
      },
    });

    return {
      stream: stream.pipeThrough(transformStream),
      ...rest,
    };
  },
};
