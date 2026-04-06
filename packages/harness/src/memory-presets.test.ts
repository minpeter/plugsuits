import { describe, expect, it } from "vitest";
import { CHAT_MEMORY_PRESET, CODE_MEMORY_PRESET } from "./memory-presets";

describe("memory-presets", () => {
  it("chat preset template contains required sections", () => {
    expect(CHAT_MEMORY_PRESET.template).toContain("# User Profile");
    expect(CHAT_MEMORY_PRESET.template).toContain("# Conversation Summary");
    expect(CHAT_MEMORY_PRESET.template).toContain("# Current Topic");
    expect(CHAT_MEMORY_PRESET.template).toContain("# Important Details");
  });

  it("code preset template contains required sections", () => {
    expect(CODE_MEMORY_PRESET.template).toContain("# Session Title");
    expect(CODE_MEMORY_PRESET.template).toContain("# Current State");
    expect(CODE_MEMORY_PRESET.template).toContain("# Task Specification");
    expect(CODE_MEMORY_PRESET.template).toContain("# Files and Functions");
    expect(CODE_MEMORY_PRESET.template).toContain("# Workflow");
    expect(CODE_MEMORY_PRESET.template).toContain("# Errors and Corrections");
    expect(CODE_MEMORY_PRESET.template).toContain("# Learnings");
    expect(CODE_MEMORY_PRESET.template).toContain("# Worklog");
  });

  it("presets include current-notes placeholder and memory tags instruction", () => {
    for (const preset of [CHAT_MEMORY_PRESET, CODE_MEMORY_PRESET]) {
      expect(preset.extractionPrompt).toContain("<current_notes>");
      expect(preset.extractionPrompt).toContain("{{currentNotes}}");
      expect(preset.extractionPrompt).toContain("<memory>");
      expect(preset.extractionPrompt).toContain("</memory>");
    }
  });
});
