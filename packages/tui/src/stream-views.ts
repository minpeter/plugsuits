import {
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
} from "@mariozechner/pi-tui";

import { colors } from "./colors";

const LEADING_NEWLINES = /^\n+/;

const styleThinkingText = (text: string): string => {
  return `${colors.dim}${colors.italic}${colors.gray}${text}${colors.reset}`;
};

interface AssistantStreamSegment {
  content: string;
  type: "reasoning" | "text";
}

export class AssistantStreamView extends Container {
  private readonly markdownTheme: MarkdownTheme;
  private readonly segments: AssistantStreamSegment[] = [];

  constructor(markdownTheme: MarkdownTheme) {
    super();
    this.markdownTheme = markdownTheme;
    this.refresh();
  }

  appendReasoning(delta: string): void {
    this.appendSegment("reasoning", delta);
  }

  appendText(delta: string): void {
    this.appendSegment("text", delta);
  }

  private appendSegment(
    type: AssistantStreamSegment["type"],
    delta: string
  ): void {
    if (delta.length === 0) {
      return;
    }

    const lastSegment = this.segments.at(-1);
    if (lastSegment && lastSegment.type === type) {
      lastSegment.content += delta;
    } else {
      this.segments.push({
        type,
        content: delta,
      });
    }

    this.refresh();
  }

  private refresh(): void {
    this.clear();

    const visibleSegments = this.segments
      .map((segment) => {
        const normalizedContent =
          segment.type === "reasoning"
            ? segment.content.replace(LEADING_NEWLINES, "").trimEnd()
            : segment.content.trim();

        return {
          ...segment,
          content: normalizedContent,
        };
      })
      .filter((segment) => segment.content.trim().length > 0);

    if (visibleSegments.length === 0) {
      return;
    }

    for (let index = 0; index < visibleSegments.length; index += 1) {
      const segment = visibleSegments[index];
      const text = segment.content;

      if (segment.type === "text") {
        this.addChild(new Markdown(text, 1, 0, this.markdownTheme));
      } else {
        this.addChild(
          new Markdown(text, 1, 0, this.markdownTheme, {
            color: styleThinkingText,
            italic: true,
          })
        );
      }

      if (index < visibleSegments.length - 1) {
        this.addChild(new Spacer(1));
      }
    }
  }
}
