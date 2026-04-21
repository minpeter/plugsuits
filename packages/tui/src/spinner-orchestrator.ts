export interface SpinnerOrchestratorAdapter {
  clearStatus: () => void;
  hasSpinner: () => boolean;
  setMessage: (message: string) => void;
  showLoader: (message: string) => void;
}

export interface SpinnerOrchestrator {
  onReasoningEnd: () => void;
  onReasoningStart: () => void;
  onToolPendingEnd: () => void;
  onToolPendingStart: () => void;
}

export const createSpinnerOrchestrator = (
  adapter: SpinnerOrchestratorAdapter,
  baseLoaderMessage: string | null | undefined
): SpinnerOrchestrator => {
  let reasoningActive = false;
  let reasoningRevivedSpinner = false;
  let toolPendingCount = 0;
  let toolRevivedSpinner = false;

  const restoreBase = (): void => {
    if (baseLoaderMessage) {
      adapter.setMessage(baseLoaderMessage);
    }
  };

  return {
    onReasoningStart: () => {
      reasoningActive = true;
      if (adapter.hasSpinner()) {
        adapter.setMessage("Thinking...");
      } else {
        adapter.showLoader("Thinking...");
        reasoningRevivedSpinner = true;
      }
    },
    onReasoningEnd: () => {
      reasoningActive = false;
      if (toolPendingCount > 0) {
        if (adapter.hasSpinner()) {
          adapter.setMessage("Executing...");
        } else {
          adapter.showLoader("Executing...");
        }
        if (reasoningRevivedSpinner) {
          toolRevivedSpinner = true;
          reasoningRevivedSpinner = false;
        }
        return;
      }
      if (reasoningRevivedSpinner) {
        adapter.clearStatus();
        reasoningRevivedSpinner = false;
        return;
      }
      restoreBase();
    },
    onToolPendingStart: () => {
      toolPendingCount += 1;
      if (reasoningActive) {
        return;
      }
      if (adapter.hasSpinner()) {
        adapter.setMessage("Executing...");
      } else {
        adapter.showLoader("Executing...");
        toolRevivedSpinner = true;
      }
    },
    onToolPendingEnd: () => {
      toolPendingCount = Math.max(0, toolPendingCount - 1);
      if (toolPendingCount > 0) {
        return;
      }
      if (reasoningActive) {
        if (toolRevivedSpinner) {
          reasoningRevivedSpinner = true;
          toolRevivedSpinner = false;
        }
        return;
      }
      if (toolRevivedSpinner) {
        adapter.clearStatus();
        toolRevivedSpinner = false;
        return;
      }
      restoreBase();
    },
  };
};
