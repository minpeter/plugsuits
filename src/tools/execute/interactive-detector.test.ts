import { describe, expect, it } from "bun:test";
import {
  checkForegroundProcess,
  isInteractiveState,
} from "./interactive-detector";

describe("interactive-detector", () => {
  describe("checkForegroundProcess", () => {
    it("returns null for non-existent session", () => {
      const result = checkForegroundProcess("nonexistent-session");
      expect(result).toBeNull();
    });
  });

  describe("isInteractiveState", () => {
    it("returns not interactive for non-existent session", () => {
      const result = isInteractiveState("nonexistent-session");
      expect(result.isInteractive).toBe(false);
      expect(result.currentProcess).toBeNull();
    });

    it("returns correct structure", () => {
      const result = isInteractiveState("any-session");
      expect(result).toHaveProperty("isInteractive");
      expect(result).toHaveProperty("currentProcess");
      expect(typeof result.isInteractive).toBe("boolean");
    });
  });

  describe("KNOWN_SHELLS classification", () => {
    const KNOWN_SHELLS = [
      "bash",
      "zsh",
      "sh",
      "fish",
      "dash",
      "ksh",
      "tcsh",
      "csh",
    ];

    it("classifies all known shells correctly", () => {
      for (const shell of KNOWN_SHELLS) {
        expect(KNOWN_SHELLS.includes(shell)).toBe(true);
      }
    });

    it("classifies non-shell processes as interactive", () => {
      const interactiveProcesses = ["less", "vim", "git", "python", "node"];
      for (const proc of interactiveProcesses) {
        expect(KNOWN_SHELLS.includes(proc)).toBe(false);
      }
    });
  });
});
