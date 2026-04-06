#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RESULTS_DIR="/tmp/cea-bench-results"
mkdir -p "$RESULTS_DIR"

TASK='Read these files one by one: packages/harness/src/checkpoint-history.ts, packages/harness/src/compaction-orchestrator.ts, packages/harness/src/session-memory.ts, packages/harness/src/compaction-policy.ts, packages/harness/src/micro-compact.ts, packages/harness/src/context-analysis.ts, packages/harness/src/context-collapse.ts, packages/harness/src/tool-pair-validation.ts, packages/harness/src/post-compact-restoration.ts, packages/harness/src/compaction-circuit-breaker.ts. After reading ALL files, do NOT re-read any of them. Instead, answer these memory probe questions from what you remember: (1) What class is exported from checkpoint-history.ts? List its 3 most important public methods. (2) What does adjustSplitIndexForToolPairs do? Which file is it in? (3) What categories does SessionMemoryTracker track by default? (4) What function does context-analysis.ts export? What does it return? (5) What is the purpose of CompactionCircuitBreaker? What are its default thresholds? (6) What does collapseConsecutiveOps do? (7) What does PostCompactRestorer track? (8) List all functions exported from compaction-policy.ts. Answer each question precisely.'

EXPECTED_FACTS=(
  "CheckpointHistory"
  "compact"
  "adjustSplitIndexForToolPairs"
  "tool-pair-validation"
  "identity"
  "preferences"
  "relationships"
  "analyzeContextTokens"
  "CompactionCircuitBreaker"
  "collapseConsecutiveOps"
  "PostCompactRestorer"
  "computeContextBudget"
  "needsCompactionFromUsage"
  "getContextPressureLevel"
)

run_bench() {
  local label="$1"
  local context_limit="$2"
  local extra_env="$3"
  local output_file="$RESULTS_DIR/${label}.jsonl"
  local log_file="$RESULTS_DIR/${label}.log"

  echo "[$label] Starting (context=$context_limit)..."

  cd "$PROJECT_ROOT"
  env COMPACTION_DEBUG=1 \
      CONTEXT_LIMIT_OVERRIDE="$context_limit" \
      $extra_env \
      node --conditions=@ai-sdk-tool/source --import tsx \
      packages/cea/src/index.ts \
      --headless --prompt "$TASK" \
      2>"$log_file" > "$output_file" || { echo "[$label] WARNING: benchmark exited with code $?"; }

  if [ ! -f "$output_file" ]; then
    : > "$output_file"
  fi

  local compactions
  compactions=$(grep -c "method=session-memory\|method=llm\|compact summary" "$log_file" 2>/dev/null) || compactions=0
  local sm_path
  sm_path=$(grep -c "method=session-memory" "$log_file" 2>/dev/null) || sm_path=0
  local llm_path
  llm_path=$(grep -c "method=llm" "$log_file" 2>/dev/null) || llm_path=0

  local last_assistant
  last_assistant=$(python3 -c "
import json, sys
lines = open('$output_file').readlines()
last_text = ''
for line in lines:
    try:
        ev = json.loads(line)
        if ev.get('type') == 'step' and ev.get('source') == 'agent' and ev.get('message'):
            last_text = ev['message']
    except: pass
print(last_text)
" 2>/dev/null || echo "")

  local found=0
  local total=${#EXPECTED_FACTS[@]}
  local found_list=""
  local missed_list=""

  for fact in "${EXPECTED_FACTS[@]}"; do
    if echo "$last_assistant" | grep -qi "$fact"; then
      found=$((found + 1))
      found_list="$found_list ✓$fact"
    else
      missed_list="$missed_list ✗$fact"
    fi
  done

  local pct=$((found * 100 / total))

  echo "[$label] Done: $found/$total ($pct%) | compactions=$compactions (SM=$sm_path, LLM=$llm_path)"
  echo "  Found:$found_list"
  if [ -n "$missed_list" ]; then
    echo "  Missed:$missed_list"
  fi

  echo "$label,$context_limit,$found,$total,$pct,$compactions,$sm_path,$llm_path" >> "$RESULTS_DIR/summary.csv"
}

echo "label,context,found,total,pct,compactions,sm_path,llm_path" > "$RESULTS_DIR/summary.csv"

echo "=== CEA Memory Benchmark: BME A/B Test ==="
echo ""

if [ "${1:-all}" = "32k" ] || [ "${1:-all}" = "all" ]; then
  run_bench "32k-bme-on"  32768  ""
  run_bench "32k-bme-off" 32768  "DISABLE_BME=1"
fi

if [ "${1:-all}" = "200k" ] || [ "${1:-all}" = "all" ]; then
  run_bench "200k-bme-on"  200000  ""
  run_bench "200k-bme-off" 200000  "DISABLE_BME=1"
fi

echo ""
echo "=== Results ==="
column -t -s, "$RESULTS_DIR/summary.csv"
echo ""
echo "Raw data: $RESULTS_DIR/"
