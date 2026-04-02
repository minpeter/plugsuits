#!/usr/bin/env python3
"""Generate compaction benchmark charts from JSON results.

Usage:
    python3 visualize.py results/1500.json results/2000.json ... --output charts/
"""

import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np


def load_results(paths: list[str]) -> list[dict]:
    results = []
    for p in paths:
        with open(p) as f:
            results.append(json.load(f))
    results.sort(key=lambda r: r["contextLimit"])
    return results


def fig_retention_curve(results: list[dict], out_dir: Path) -> None:
    ctx_sizes = [r["contextLimit"] for r in results]
    retention = [r["summary"]["retentionPct"] for r in results]
    compactions = [r["summary"]["compactionCycles"] for r in results]

    fig, ax1 = plt.subplots(figsize=(10, 5))

    color_ret = "#2563eb"
    color_comp = "#ef4444"

    ax1.plot(
        ctx_sizes,
        retention,
        "o-",
        color=color_ret,
        linewidth=2.5,
        markersize=10,
        zorder=5,
    )
    for x, y in zip(ctx_sizes, retention):
        ax1.annotate(
            f"{y}%",
            (x, y),
            textcoords="offset points",
            xytext=(0, 14),
            ha="center",
            fontsize=11,
            fontweight="bold",
            color=color_ret,
        )
    ax1.set_xlabel("Context Limit (tokens)", fontsize=12)
    ax1.set_ylabel("Memory Retention (%)", fontsize=12, color=color_ret)
    ax1.tick_params(axis="y", labelcolor=color_ret)
    ax1.set_ylim(0, 105)
    ax1.set_xticks(ctx_sizes)
    ax1.grid(axis="y", alpha=0.3)

    ax2 = ax1.twinx()
    ax2.bar(
        ctx_sizes,
        compactions,
        width=[c * 0.08 for c in ctx_sizes],
        alpha=0.35,
        color=color_comp,
        zorder=2,
    )
    for x, y in zip(ctx_sizes, compactions):
        if y > 0:
            ax2.annotate(
                f"{y}×",
                (x, y),
                textcoords="offset points",
                xytext=(0, 6),
                ha="center",
                fontsize=10,
                color=color_comp,
            )
    ax2.set_ylabel("Compaction Cycles", fontsize=12, color=color_comp)
    ax2.tick_params(axis="y", labelcolor=color_comp)
    ax2.set_ylim(0, max(compactions) + 2 if max(compactions) > 0 else 5)

    fig.suptitle(
        "Memory Retention vs Context Size",
        fontsize=14,
        fontweight="bold",
        y=0.98,
    )
    ax1.set_title(
        "Higher context → fewer compaction cycles → better retention",
        fontsize=10,
        color="gray",
        style="italic",
    )
    fig.tight_layout()
    fig.savefig(out_dir / "retention_curve.png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  → {out_dir / 'retention_curve.png'}")


def fig_token_usage(results: list[dict], out_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(12, 5))

    colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6"]

    for i, r in enumerate(results):
        ctx = r["contextLimit"]
        turns = [t["turn"] for t in r["turns"]]
        tokens = [t["contextAfter"] for t in r["turns"]]
        color = colors[i % len(colors)]

        ax.plot(
            turns,
            tokens,
            "o-",
            color=color,
            linewidth=2,
            markersize=4,
            label=f"{ctx} tokens",
        )

        for t in r["turns"]:
            if t["compactionEvent"] and "compacted" in t["compactionEvent"]:
                ax.axvline(x=t["turn"], color=color, linestyle="--", alpha=0.4)
                ax.plot(
                    t["turn"],
                    t["contextAfter"],
                    "v",
                    color=color,
                    markersize=12,
                    zorder=10,
                )

        ax.axhline(y=r["blockingThreshold"], color=color, linestyle=":", alpha=0.3)

    probe_turns = [t["turn"] for t in results[0]["turns"] if t["type"] == "probe"]
    for pt in probe_turns:
        ax.axvline(x=pt, color="gray", linestyle="-", alpha=0.1, linewidth=8)

    ax.set_xlabel("Turn", fontsize=12)
    ax.set_ylabel("Context Tokens Used", fontsize=12)
    ax.set_title("Context Token Usage Over 30 Turns", fontsize=14, fontweight="bold")
    ax.legend(loc="upper left", fontsize=10)
    ax.grid(axis="both", alpha=0.2)
    ax.set_xlim(0.5, 30.5)
    ax.set_xticks(range(1, 31))
    ax.tick_params(axis="x", labelsize=8)

    fig.tight_layout()
    fig.savefig(out_dir / "token_usage.png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  → {out_dir / 'token_usage.png'}")


def fig_probe_heatmap(results: list[dict], out_dir: Path) -> None:
    ctx_sizes = [r["contextLimit"] for r in results]
    probe_turns = [p["turn"] for p in results[0]["probes"]]

    data = np.zeros((len(results), len(probe_turns)))
    for i, r in enumerate(results):
        for j, p in enumerate(r["probes"]):
            data[i, j] = p["found"] / p["expected"] * 100 if p["expected"] > 0 else 0

    fig, ax = plt.subplots(figsize=(8, max(3, len(results) * 0.8 + 1)))

    im = ax.imshow(data, cmap="RdYlGn", aspect="auto", vmin=0, vmax=100)

    ax.set_xticks(range(len(probe_turns)))
    ax.set_xticklabels([f"Turn {t}" for t in probe_turns], fontsize=10)
    ax.set_yticks(range(len(ctx_sizes)))
    ax.set_yticklabels([f"{c} tokens" for c in ctx_sizes], fontsize=10)

    for i in range(len(results)):
        for j in range(len(probe_turns)):
            p = results[i]["probes"][j]
            val = data[i, j]
            text_color = "white" if val < 50 else "black"
            ax.text(
                j,
                i,
                f"{p['found']}/{p['expected']}",
                ha="center",
                va="center",
                fontsize=11,
                fontweight="bold",
                color=text_color,
            )

    cbar = fig.colorbar(im, ax=ax, label="Recall %", shrink=0.8)
    cbar.set_ticks([0, 25, 50, 75, 100])

    ax.set_title(
        "Memory Probe Results by Context Size",
        fontsize=14,
        fontweight="bold",
        pad=12,
    )
    fig.tight_layout()
    fig.savefig(out_dir / "probe_heatmap.png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  → {out_dir / 'probe_heatmap.png'}")


def fig_improvement_summary(results: list[dict], out_dir: Path) -> None:
    fig, axes = plt.subplots(1, 3, figsize=(14, 4))

    ctx_sizes = [r["contextLimit"] for r in results]
    retention = [r["summary"]["retentionPct"] for r in results]
    compactions = [r["summary"]["compactionCycles"] for r in results]
    peaks = [r["summary"]["peakTokens"] for r in results]

    bar_colors = ["#fee2e2", "#fef3c7", "#d1fae5", "#dbeafe", "#ede9fe"]
    edge_colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6"]

    labels = [str(c) for c in ctx_sizes]

    axes[0].bar(
        labels,
        retention,
        color=bar_colors[: len(results)],
        edgecolor=edge_colors[: len(results)],
        linewidth=2,
    )
    axes[0].set_ylabel("Retention %")
    axes[0].set_title("Memory Retention", fontweight="bold")
    axes[0].set_ylim(0, 105)
    for i, v in enumerate(retention):
        axes[0].text(i, v + 2, f"{v}%", ha="center", fontweight="bold", fontsize=10)

    axes[1].bar(
        labels,
        compactions,
        color=bar_colors[: len(results)],
        edgecolor=edge_colors[: len(results)],
        linewidth=2,
    )
    axes[1].set_ylabel("Cycles")
    axes[1].set_title("Compaction Cycles", fontweight="bold")
    for i, v in enumerate(compactions):
        axes[1].text(i, v + 0.1, str(v), ha="center", fontweight="bold", fontsize=10)

    utilization = [p / c * 100 for p, c in zip(peaks, ctx_sizes)]
    axes[2].bar(
        labels,
        utilization,
        color=bar_colors[: len(results)],
        edgecolor=edge_colors[: len(results)],
        linewidth=2,
    )
    axes[2].set_ylabel("Peak Usage %")
    axes[2].set_title("Context Utilization", fontweight="bold")
    axes[2].set_ylim(0, 120)
    for i, v in enumerate(utilization):
        axes[2].text(i, v + 2, f"{v:.0f}%", ha="center", fontweight="bold", fontsize=10)

    for ax in axes:
        ax.set_xlabel("Context Limit")
        ax.grid(axis="y", alpha=0.3)

    fig.suptitle(
        "Compaction Benchmark Summary",
        fontsize=14,
        fontweight="bold",
        y=1.02,
    )
    fig.tight_layout()
    fig.savefig(out_dir / "summary.png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  → {out_dir / 'summary.png'}")


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python3 visualize.py <json_files...> [--output DIR]")
        sys.exit(1)

    args = sys.argv[1:]
    out_dir = Path("charts")

    if "--output" in args:
        idx = args.index("--output")
        out_dir = Path(args[idx + 1])
        args = args[:idx] + args[idx + 2 :]

    json_files = [a for a in args if not a.startswith("--")]

    if not json_files:
        print("Error: No JSON files provided")
        sys.exit(1)

    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading {len(json_files)} benchmark results...")
    results = load_results(json_files)

    for r in results:
        s = r["summary"]
        print(
            f"  {r['contextLimit']} tokens: {s['retentionPct']}% retention, {s['compactionCycles']} compactions"
        )

    print("\nGenerating charts...")
    fig_retention_curve(results, out_dir)
    fig_token_usage(results, out_dir)
    fig_probe_heatmap(results, out_dir)
    fig_improvement_summary(results, out_dir)
    print(f"\nDone! Charts saved to {out_dir}/")


if __name__ == "__main__":
    main()
