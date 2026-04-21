import { describe, expect, it, vi } from "vitest";
import {
  createSpinnerOrchestrator,
  type SpinnerOrchestratorAdapter,
} from "./spinner-orchestrator";

const createAdapter = (initialHasSpinner = true) => {
  let hasSpinner = initialHasSpinner;
  let currentMessage: string | null = initialHasSpinner ? "Working..." : null;
  const events: Array<
    | { type: "clearStatus" }
    | { type: "setMessage"; message: string }
    | { type: "showLoader"; message: string }
  > = [];

  const adapter: SpinnerOrchestratorAdapter = {
    clearStatus: () => {
      hasSpinner = false;
      currentMessage = null;
      events.push({ type: "clearStatus" });
    },
    hasSpinner: () => hasSpinner,
    setMessage: (message) => {
      currentMessage = message;
      events.push({ type: "setMessage", message });
    },
    showLoader: (message) => {
      hasSpinner = true;
      currentMessage = message;
      events.push({ type: "showLoader", message });
    },
  };

  return {
    adapter,
    events,
    state: () => ({ hasSpinner, currentMessage }),
  };
};

describe("createSpinnerOrchestrator", () => {
  describe("reasoning lifecycle", () => {
    it("swaps label to Thinking... when spinner already exists", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onReasoningStart();
      expect(h.state()).toEqual({
        hasSpinner: true,
        currentMessage: "Thinking...",
      });

      orch.onReasoningEnd();
      expect(h.state()).toEqual({
        hasSpinner: true,
        currentMessage: "Working...",
      });
    });

    it("revives spinner via showLoader when spinner was cleared", () => {
      const h = createAdapter(false);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onReasoningStart();
      expect(h.events).toContainEqual({
        type: "showLoader",
        message: "Thinking...",
      });

      orch.onReasoningEnd();
      expect(h.events).toContainEqual({ type: "clearStatus" });
      expect(h.state().hasSpinner).toBe(false);
    });
  });

  describe("tool lifecycle", () => {
    it("swaps label to Executing... when spinner already exists", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onToolPendingStart();
      expect(h.state().currentMessage).toBe("Executing...");

      orch.onToolPendingEnd();
      expect(h.state().currentMessage).toBe("Working...");
    });

    it("revives spinner via showLoader when spinner was cleared", () => {
      const h = createAdapter(false);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onToolPendingStart();
      expect(h.events).toContainEqual({
        type: "showLoader",
        message: "Executing...",
      });

      orch.onToolPendingEnd();
      expect(h.state().hasSpinner).toBe(false);
    });

    it("keeps Executing... until all parallel tool calls finish", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onToolPendingStart();
      orch.onToolPendingStart();
      expect(h.state().currentMessage).toBe("Executing...");

      orch.onToolPendingEnd();
      expect(h.state().currentMessage).toBe("Executing...");

      orch.onToolPendingEnd();
      expect(h.state().currentMessage).toBe("Working...");
    });

    it("counter never goes negative", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onToolPendingEnd();
      orch.onToolPendingEnd();
      orch.onToolPendingStart();
      expect(h.state().currentMessage).toBe("Executing...");

      orch.onToolPendingEnd();
      expect(h.state().currentMessage).toBe("Working...");
    });
  });

  describe("reasoning + tool overlap (regression lock)", () => {
    // Regression: onToolPendingStart used to overwrite Thinking... with
    // Executing... when a tool started during an active reasoning span.
    it("tool starting during reasoning does not overwrite Thinking...", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onReasoningStart();
      expect(h.state().currentMessage).toBe("Thinking...");

      orch.onToolPendingStart();
      expect(h.state().currentMessage).toBe("Thinking...");
    });

    // Regression: onToolPendingEnd used to restore Working... while
    // reasoning was still active, clobbering the Thinking... label.
    it("tool ending during reasoning does not overwrite Thinking...", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onToolPendingStart();
      orch.onReasoningStart();
      expect(h.state().currentMessage).toBe("Thinking...");

      orch.onToolPendingEnd();
      expect(h.state().currentMessage).toBe("Thinking...");

      orch.onReasoningEnd();
      expect(h.state().currentMessage).toBe("Working...");
    });

    // Regression: onReasoningEnd restored Working... even when tool calls
    // were still pending, hiding active tool execution.
    it("reasoning ending while tool is still pending transitions to Executing...", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onReasoningStart();
      orch.onToolPendingStart();
      expect(h.state().currentMessage).toBe("Thinking...");

      orch.onReasoningEnd();
      expect(h.state().currentMessage).toBe("Executing...");

      orch.onToolPendingEnd();
      expect(h.state().currentMessage).toBe("Working...");
    });

    it("reasoning ending with multiple pending tools keeps Executing... until all resolve", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onReasoningStart();
      orch.onToolPendingStart();
      orch.onToolPendingStart();
      orch.onReasoningEnd();
      expect(h.state().currentMessage).toBe("Executing...");

      orch.onToolPendingEnd();
      expect(h.state().currentMessage).toBe("Executing...");

      orch.onToolPendingEnd();
      expect(h.state().currentMessage).toBe("Working...");
    });

    // Regression: spinner ownership transfer when reasoning revived a
    // cleared spinner and then ended while a tool was still pending.
    it("reasoning-revived spinner becomes tool-owned when reasoning ends mid-tool", () => {
      const h = createAdapter(false);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");

      orch.onReasoningStart();
      expect(h.events).toContainEqual({
        type: "showLoader",
        message: "Thinking...",
      });

      orch.onToolPendingStart();
      expect(h.state().currentMessage).toBe("Thinking...");

      orch.onReasoningEnd();
      expect(h.state().currentMessage).toBe("Executing...");

      orch.onToolPendingEnd();
      expect(h.events).toContainEqual({ type: "clearStatus" });
      expect(h.state().hasSpinner).toBe(false);
    });
  });

  describe("missing baseLoaderMessage", () => {
    it("leaves the spinner alone when no base label is configured", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, undefined);

      orch.onReasoningStart();
      expect(h.state().currentMessage).toBe("Thinking...");

      orch.onReasoningEnd();
      expect(h.state().currentMessage).toBe("Thinking...");
    });

    it("accepts null as well as undefined", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, null);

      orch.onReasoningStart();
      orch.onReasoningEnd();
      expect(h.state().currentMessage).toBe("Thinking...");
    });
  });

  describe("adapter is called precisely", () => {
    it("does not fire any adapter method for counter-only transitions during reasoning", () => {
      const h = createAdapter(true);
      const orch = createSpinnerOrchestrator(h.adapter, "Working...");
      const setMessage = vi.spyOn(h.adapter, "setMessage");
      const showLoader = vi.spyOn(h.adapter, "showLoader");
      const clearStatus = vi.spyOn(h.adapter, "clearStatus");

      orch.onReasoningStart();
      setMessage.mockClear();
      showLoader.mockClear();
      clearStatus.mockClear();

      orch.onToolPendingStart();
      orch.onToolPendingEnd();

      expect(setMessage).not.toHaveBeenCalled();
      expect(showLoader).not.toHaveBeenCalled();
      expect(clearStatus).not.toHaveBeenCalled();
    });
  });
});
