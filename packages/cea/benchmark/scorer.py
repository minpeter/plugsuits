#!/usr/bin/env python3
"""Trajectory analysis scorer for compaction benchmarks.

Usage:
  python3 scorer.py trajectory.json           # Single trajectory analysis
  python3 scorer.py --compare a.json b.json   # Side-by-side comparison
"""

from __future__ import annotations

# pyright: basic, reportUnusedImport=false, reportUnusedCallResult=false
import argparse
import json
import sys
from datetime import datetime, timezone


def parse_timestamp(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def score_trajectory(trajectory: dict) -> dict:
    """Compute performance metrics from an ATIF-v1.4 trajectory dict."""
    steps = trajectory.get("steps", [])
    fm = trajectory.get("final_metrics", {}) or {}
    compaction_events = trajectory.get("extra", {}).get("compaction_events", [])

    # Token metrics
    total_prompt = fm.get("total_prompt_tokens")
    total_completion = fm.get("total_completion_tokens")
    total_cached = fm.get("total_cached_tokens")

    token_efficiency_ratio: float | None = None
    if total_prompt and total_completion is not None:
        token_efficiency_ratio = round(total_completion / total_prompt, 4)

    # Compaction metrics
    compaction_count = len(compaction_events)
    blocking_count = sum(
        1
        for e in compaction_events
        if e.get("event") == "blocking_change" and e.get("blocking") is True
    )
    total_duration_ms = sum(e.get("durationMs") or 0 for e in compaction_events)
    complete_events = [e for e in compaction_events if e.get("event") == "complete"]
    token_savings = sum(
        (e.get("tokensBefore") or 0) - (e.get("tokensAfter") or 0)
        for e in complete_events
    )
    avg_ratio: float | None = None
    if complete_events:
        ratios = [
            (e.get("tokensAfter") or 0) / max(e.get("tokensBefore") or 1, 1)
            for e in complete_events
        ]
        avg_ratio = round(sum(ratios) / len(ratios), 4)

    # Execution time
    timestamps = [parse_timestamp(s.get("timestamp")) for s in steps]
    timestamps = [t for t in timestamps if t is not None]
    execution_time_s: float | None = None
    if len(timestamps) >= 2:
        execution_time_s = round((max(timestamps) - min(timestamps)).total_seconds(), 2)

    return {
        "total_steps": len(steps),
        "total_prompt_tokens": total_prompt,
        "total_completion_tokens": total_completion,
        "total_cached_tokens": total_cached,
        "token_efficiency_ratio": token_efficiency_ratio,
        "compaction_count": compaction_count,
        "blocking_compaction_count": blocking_count,
        "total_compaction_duration_ms": total_duration_ms,
        "compaction_token_savings": token_savings,
        "avg_compaction_ratio": avg_ratio,
        "execution_time_s": execution_time_s,
    }


def load_trajectory(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def print_summary(report: dict, label: str = "") -> None:
    prefix = f"[{label}] " if label else ""
    sys.stderr.write(f"\n{prefix}=== Trajectory Score ===\n")
    sys.stderr.write(f"  Steps:               {report['total_steps']}\n")
    sys.stderr.write(f"  Prompt tokens:       {report['total_prompt_tokens']}\n")
    sys.stderr.write(f"  Completion tokens:   {report['total_completion_tokens']}\n")
    sys.stderr.write(f"  Token efficiency:    {report['token_efficiency_ratio']}\n")
    sys.stderr.write(f"  Compactions:         {report['compaction_count']}\n")
    sys.stderr.write(f"  Blocking compacts:   {report['blocking_compaction_count']}\n")
    sys.stderr.write(
        f"  Compact duration:    {report['total_compaction_duration_ms']}ms\n"
    )
    sys.stderr.write(f"  Token savings:       {report['compaction_token_savings']}\n")
    sys.stderr.write(f"  Avg compact ratio:   {report['avg_compaction_ratio']}\n")
    sys.stderr.write(f"  Execution time:      {report['execution_time_s']}s\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Score ATIF trajectory files.")
    parser.add_argument("trajectory", nargs="?", help="Path to trajectory.json")
    parser.add_argument(
        "--compare",
        nargs=2,
        metavar=("BASELINE", "CANDIDATE"),
        help="Compare two trajectory files",
    )
    args = parser.parse_args()

    if args.compare:
        baseline_path, candidate_path = args.compare
        baseline = score_trajectory(load_trajectory(baseline_path))
        candidate = score_trajectory(load_trajectory(candidate_path))
        print_summary(baseline, "baseline")
        print_summary(candidate, "candidate")
        result = {"baseline": baseline, "candidate": candidate}
        print(json.dumps(result, indent=2))

    elif args.trajectory:
        t = load_trajectory(args.trajectory)
        report = score_trajectory(t)
        print_summary(report)
        print(json.dumps(report, indent=2))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
