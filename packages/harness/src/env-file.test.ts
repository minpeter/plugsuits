import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env-file";

describe("parseEnvFile", () => {
  it("preserves multi-line quoted values", () => {
    expect(
      parseEnvFile(`MULTILINE="first
second"
NEXT=value`)
    ).toEqual({
      MULTILINE: "first\nsecond",
      NEXT: "value",
    });
  });

  it("strips inline comments from unquoted values", () => {
    expect(parseEnvFile("AI_MODEL=openai/gpt-5.4 # default model")).toEqual({
      AI_MODEL: "openai/gpt-5.4",
    });
  });

  it("keeps hash characters inside quoted values", () => {
    expect(parseEnvFile('TOKEN="abc#123"')).toEqual({
      TOKEN: "abc#123",
    });
  });

  it("ignores comments after quoted values without consuming later lines", () => {
    expect(
      parseEnvFile(`AI_MODEL="openai/gpt-5.4" # default model
AI_API_KEY=secret`)
    ).toEqual({
      AI_MODEL: "openai/gpt-5.4",
      AI_API_KEY: "secret",
    });
  });

  it("treats backslash quote as the closing quote", () => {
    expect(
      parseEnvFile(`A="x\\" # note
B=next`)
    ).toEqual({
      A: "x\\",
      B: "next",
    });
  });

  it("matches native loader escape handling for common double-quoted values", () => {
    expect(parseEnvFile('VALUE="a\\n\\t\\r\\\\b"')).toEqual({
      VALUE: "a\n\\t\\r\\\\b",
    });
  });
});
