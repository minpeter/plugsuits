import type { Interface as ReadlineInterface } from "node:readline";
import type { ToolApprovalResponse } from "ai";
import { colorize } from "./colors";
import type { ToolApprovalRequestPart } from "./stream-renderer";

const TOOL_DENIAL_GUIDANCE =
  "Consider: 1) Find alternative approaches that don't require these tools, 2) Ask the user why they denied them, or 3) Reflect on whether you misunderstood the task.";

const createDenialReason = (toolNames: string): string =>
  `User denied the following tools: ${toolNames}. ${TOOL_DENIAL_GUIDANCE}`;

/**
 * Promisified question for basic readline interface.
 * Only reads the first line (no multiline buffering needed for y/n prompts).
 */
const question = (rl: ReadlineInterface, prompt: string): Promise<string> => {
  return new Promise((resolve) => {
    const onLine = (line: string) => {
      rl.removeListener("line", onLine);
      rl.removeListener("close", onClose);
      resolve(line);
    };

    const onClose = () => {
      rl.removeListener("line", onLine);
      resolve("");
    };

    rl.once("line", onLine);
    rl.once("close", onClose);
    process.stdout.write(prompt);
  });
};

const formatToolInput = (input: unknown): string => {
  try {
    const str = JSON.stringify(input, null, 2);
    const lines = str.split("\n");
    if (lines.length > 5) {
      return `${lines.slice(0, 5).join("\n")}\n    ...`;
    }
    return str;
  } catch {
    return String(input);
  }
};

const renderApprovalBox = (requests: ToolApprovalRequestPart[]): void => {
  const boxWidth = 65;
  const horizontal = "─".repeat(boxWidth - 2);

  console.log();
  console.log(colorize("yellow", `┌${horizontal}┐`));
  console.log(
    colorize(
      "yellow",
      `${`│ ⚠ APPROVAL REQUIRED (${requests.length} tool${requests.length > 1 ? "s" : ""})`.padEnd(boxWidth - 1)}│`
    )
  );
  console.log(colorize("yellow", `├${horizontal}┤`));

  for (const [idx, req] of requests.entries()) {
    const toolLine = ` ${idx + 1}. ${req.toolCall.toolName}`;
    console.log(colorize("cyan", `│${toolLine.padEnd(boxWidth - 2)}│`));

    const inputLines = formatToolInput(req.toolCall.input).split("\n");
    for (const line of inputLines) {
      const paddedLine = `    ${line}`.slice(0, boxWidth - 3);
      console.log(colorize("dim", `│${paddedLine.padEnd(boxWidth - 2)}│`));
    }

    if (idx < requests.length - 1) {
      console.log(colorize("yellow", `│${" ".repeat(boxWidth - 2)}│`));
    }
  }

  console.log(colorize("yellow", `├${horizontal}┤`));
  const options =
    requests.length > 1
      ? " [a] Approve all  [y] One-by-one  [n] Deny all"
      : " [y] Approve  [n] Deny";
  console.log(colorize("green", `│${options.padEnd(boxWidth - 2)}│`));
  console.log(colorize("yellow", `└${horizontal}┘`));
};

const askSingleApproval = async (
  rl: ReadlineInterface,
  request: ToolApprovalRequestPart,
  index: number,
  total: number
): Promise<ToolApprovalResponse> => {
  const { approvalId, toolCall } = request;
  const prompt = colorize(
    "yellow",
    `\n[${index + 1}/${total}] Approve "${toolCall.toolName}"? (y/N): `
  );

  const answer = await question(rl, prompt);
  const approved = answer.toLowerCase() === "y";

  return {
    type: "tool-approval-response",
    approvalId,
    approved,
    reason: approved
      ? "User approved"
      : createDenialReason(`"${toolCall.toolName}"`),
  };
};

export const askBatchApproval = async (
  rl: ReadlineInterface,
  requests: ToolApprovalRequestPart[]
): Promise<ToolApprovalResponse[]> => {
  renderApprovalBox(requests);

  const prompt =
    requests.length > 1
      ? colorize("yellow", "\nChoice [a/y/n]: ")
      : colorize("yellow", "\nChoice [y/n]: ");

  const answer = (await question(rl, prompt)).toLowerCase().trim();

  if (requests.length > 1 && answer === "a") {
    return requests.map((req) => ({
      type: "tool-approval-response" as const,
      approvalId: req.approvalId,
      approved: true,
      reason: "User approved all",
    }));
  }

  if (answer === "n") {
    const toolNames = requests
      .map((r) => `"${r.toolCall.toolName}"`)
      .join(", ");
    return requests.map((req) => ({
      type: "tool-approval-response" as const,
      approvalId: req.approvalId,
      approved: false,
      reason: createDenialReason(toolNames),
    }));
  }

  if (answer === "y") {
    if (requests.length === 1) {
      return [
        {
          type: "tool-approval-response",
          approvalId: requests[0].approvalId,
          approved: true,
          reason: "User approved",
        },
      ];
    }

    const approvals: ToolApprovalResponse[] = [];
    for (const [idx, req] of requests.entries()) {
      const approval = await askSingleApproval(rl, req, idx, requests.length);
      approvals.push(approval);
    }
    return approvals;
  }

  const toolNames = requests.map((r) => `"${r.toolCall.toolName}"`).join(", ");
  return requests.map((req) => ({
    type: "tool-approval-response" as const,
    approvalId: req.approvalId,
    approved: false,
    reason: createDenialReason(toolNames),
  }));
};
