import { describe, expect, it } from "vitest";
import { shellExecuteTool } from "./execute/shell-execute";
import { shellInteractTool } from "./execute/shell-interact";
import { deleteFileTool } from "./modify/delete-file";
import { editFileTool } from "./modify/edit-file";
import { writeFileTool } from "./modify/write-file";

describe("high-risk tools", () => {
  it("require explicit approval before execution", () => {
    expect(shellExecuteTool.needsApproval).toBe(true);
    expect(shellInteractTool.needsApproval).toBe(true);
    expect(writeFileTool.needsApproval).toBe(true);
    expect(editFileTool.needsApproval).toBe(true);
    expect(deleteFileTool.needsApproval).toBe(true);
  });
});
