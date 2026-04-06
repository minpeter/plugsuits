#!/usr/bin/env python3
"""ATIF-v1.6 trajectory validation test.

Usage: python3 test_trajectory.py <trajectory.json>
"""

from __future__ import annotations
import json
import sys
from pathlib import Path


def validate_trajectory(path: str) -> list[str]:
    """Validate trajectory.json against ATIF-v1.6 spec. Returns list of errors."""
    errors = []

    try:
        with open(path) as f:
            t = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        return [f"Cannot read/parse file: {e}"]

    # 1. schema_version
    if t.get("schema_version") != "ATIF-v1.6":
        errors.append(
            f"schema_version: expected 'ATIF-v1.6', got {t.get('schema_version')!r}"
        )

    # 2. session_id present
    if not t.get("session_id"):
        errors.append("session_id: missing or empty")

    # 3. agent section
    agent = t.get("agent", {})
    for field in ["name", "version", "model_name"]:
        if not agent.get(field):
            errors.append(f"agent.{field}: missing or empty")

    # 4. steps array
    steps = t.get("steps", [])
    if not isinstance(steps, list) or len(steps) == 0:
        errors.append("steps: must be a non-empty array")
        return errors  # can't validate step ids without steps

    # 5. step_ids are sequential from 1
    step_ids = []
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            errors.append(f"Step {i} is not a dictionary")
            continue
        step_ids.append(step.get("step_id"))
    expected = list(range(1, len(steps) + 1))
    if step_ids != expected:
        errors.append(f"step_ids: expected {expected}, got {step_ids}")

    # 6. each step has required fields
    valid_sources = {"user", "agent", "system"}
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        for field in ["step_id", "timestamp", "source", "message"]:
            if step.get(field) is None:
                errors.append(f"steps[{i}].{field}: missing")
        source = step.get("source")
        if source not in valid_sources:
            errors.append(
                f"steps[{i}].source: expected one of {valid_sources}, got {source!r}"
            )

    # 7. agent steps with tool_calls must have matching observations
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        if step.get("source") == "agent" and step.get("tool_calls"):
            obs = step.get("observation", {})
            if not obs or not obs.get("results"):
                errors.append(f"steps[{i}]: has tool_calls but no observation.results")

    # 8. final_metrics present (not required to be non-null)
    if "final_metrics" not in t:
        errors.append("final_metrics: missing")
    else:
        fm = t["final_metrics"]
        if not isinstance(fm, dict):
            errors.append("final_metrics must be a dictionary")
            return errors
        if not isinstance(fm.get("total_steps"), int):
            errors.append("final_metrics.total_steps: must be an integer")

    return errors


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python3 test_trajectory.py <trajectory.json>")
        sys.exit(1)

    path = sys.argv[1]
    errors = validate_trajectory(path)

    if errors:
        print(f"VALIDATION FAILED: {path}")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        # Load and print summary
        with open(path) as f:
            t = json.load(f)
        steps = t.get("steps", [])
        fm = t.get("final_metrics", {})
        print(f"OK: {path}")
        print(f"  schema_version: {t.get('schema_version')}")
        print(f"  session_id: {t.get('session_id')}")
        print(f"  steps: {len(steps)}")
        print(
            f"  final_metrics: total_prompt={fm.get('total_prompt_tokens')}, total_completion={fm.get('total_completion_tokens')}"
        )
        print(
            f"  compaction_events: {len(t.get('extra', {}).get('compaction_events', []))}"
        )
        sys.exit(0)


if __name__ == "__main__":
    main()
