import { describe, expect, it, vi } from "vitest";
import { SessionMemoryTracker } from "./session-memory";
import { estimateTokens } from "./token-utils";

function expectDefined(value: string | undefined): string {
  if (typeof value === "undefined") {
    throw new Error("Expected string value");
  }
  return value;
}

describe("SessionMemoryTracker", () => {
  it("supports set/get/remove fact CRUD", () => {
    const tracker = new SessionMemoryTracker();

    tracker.setFact("identity", "name", "Alice");
    expect(tracker.getFact("identity", "name")).toBe("Alice");

    tracker.setFact("identity", "name", "Alicia");
    expect(tracker.getFact("identity", "name")).toBe("Alicia");
    expect(tracker.getCategory("identity")).toHaveLength(1);

    tracker.setFact("unknown-category", "timezone", "KST");
    expect(tracker.getFact("other", "timezone")).toBe("KST");

    expect(tracker.removeFact("identity", "name")).toBe(true);
    expect(tracker.getFact("identity", "name")).toBeUndefined();
    expect(tracker.removeFact("identity", "name")).toBe(false);
  });

  it("returns undefined structured state when empty", () => {
    const tracker = new SessionMemoryTracker();
    expect(tracker.getStructuredState()).toBeUndefined();
  });

  it("renders structured state markdown", () => {
    const tracker = new SessionMemoryTracker();

    tracker.setFact("identity", "name", "Alice");
    tracker.setFact("identity", "job", "Software engineer");
    tracker.setFact("preferences", "food", "Italian");
    tracker.setFact(
      "relationships",
      "sister",
      "Emma (graphic designer, New York)"
    );

    const state = expectDefined(tracker.getStructuredState());

    expect(state).toContain("## Session Memory");
    expect(state).toContain("### Identity");
    expect(state).toContain("- name: Alice");
    expect(state).toContain("- job: Software engineer");
    expect(state).toContain("### Preferences");
    expect(state).toContain("- food: Italian");
    expect(state).toContain("### Relationships");
    expect(state).toContain("- sister: Emma (graphic designer, New York)");
  });

  it("extracts facts from User Profile section", () => {
    const tracker = new SessionMemoryTracker();

    tracker.extractFactsFromSummary(`
## 1. User Profile
- **name**: Alice
- job: Software engineer
- favorite food: Italian
- partner: David (teacher)

## 2. Current Goal
- Keep implementing tests
`);

    expect(tracker.getFact("identity", "name")).toBe("Alice");
    expect(tracker.getFact("identity", "job")).toBe("Software engineer");
    expect(tracker.getFact("preferences", "favorite food")).toBe("Italian");
    expect(tracker.getFact("relationships", "partner")).toBe("David (teacher)");
    expect(
      tracker.getFact("context", "keep implementing tests")
    ).toBeUndefined();
  });

  it("evicts oldest facts first when maxFacts is exceeded", () => {
    vi.useFakeTimers();

    try {
      const tracker = new SessionMemoryTracker({ maxFacts: 2 });

      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      tracker.setFact("identity", "name", "Alice");

      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      tracker.setFact("preferences", "color", "Blue");

      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      tracker.setFact("relationships", "partner", "David");

      expect(tracker.size).toBe(2);
      expect(tracker.getFact("identity", "name")).toBeUndefined();
      expect(tracker.getFact("preferences", "color")).toBe("Blue");
      expect(tracker.getFact("relationships", "partner")).toBe("David");
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncates structured state to maxStateTokens", () => {
    const tracker = new SessionMemoryTracker({ maxStateTokens: 30 });

    tracker.setFact("identity", "name", "Alice");
    tracker.setFact("preferences", "favorite movie", "x".repeat(200));
    tracker.setFact("relationships", "friend", "y".repeat(200));

    const state = expectDefined(tracker.getStructuredState());
    expect(estimateTokens(state)).toBeLessThanOrEqual(30);

    const missingFacts = ["name", "favorite movie", "friend"].filter(
      (key) => !state.includes(`- ${key}:`)
    );
    expect(missingFacts.length).toBeGreaterThan(0);
  });

  it("supports toJSON/fromJSON roundtrip", () => {
    const tracker = new SessionMemoryTracker();
    tracker.setFact("identity", "name", "Alice");
    tracker.setFact("preferences", "food", "Italian");

    const serialized = tracker.toJSON();
    const restored = new SessionMemoryTracker();
    restored.fromJSON(serialized);

    expect(restored.toJSON()).toEqual(serialized);
    expect(restored.getFact("identity", "name")).toBe("Alice");
    expect(restored.getFact("preferences", "food")).toBe("Italian");
  });

  it("clears all stored facts", () => {
    const tracker = new SessionMemoryTracker();
    tracker.setFact("identity", "name", "Alice");
    tracker.setFact("preferences", "food", "Italian");

    tracker.clear();

    expect(tracker.size).toBe(0);
    expect(tracker.getAllFacts()).toEqual([]);
    expect(tracker.getStructuredState()).toBeUndefined();
  });
});
