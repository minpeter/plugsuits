#!/bin/bash
# Verifier for compaction-stress-short
set -e

REWARD=0
PASS=0
FAIL=0
REWARD_FILE="/logs/verifier/reward.txt"
mkdir -p /logs/verifier

# Check all 5 files exist
for f in /agent/work/config.json /agent/work/README.md /agent/work/main.py /agent/work/test.py /agent/work/deploy.sh; do
    if [ -f "$f" ]; then
        PASS=$((PASS + 1))
    else
        echo "MISSING: $f"
        FAIL=$((FAIL + 1))
    fi
done

# Check answers.txt exists
if [ ! -f /agent/work/answers.txt ]; then
    echo "MISSING: /agent/work/answers.txt"
    echo "$REWARD" > "$REWARD_FILE"
    exit 0
fi

# Read answers
PORT=$(sed -n '1p' /agent/work/answers.txt | tr -d '[:space:]')
SERVICE=$(sed -n '2p' /agent/work/answers.txt | tr -d '[:space:]')
MAX_CONN=$(sed -n '3p' /agent/work/answers.txt | tr -d '[:space:]')

# Validate answers
[ "$PORT" = "8080" ] && PASS=$((PASS + 1)) || { echo "WRONG PORT: got '$PORT', expected '8080'"; FAIL=$((FAIL + 1)); }
[ "$SERVICE" = "auth" ] && PASS=$((PASS + 1)) || { echo "WRONG SERVICE: got '$SERVICE', expected 'auth'"; FAIL=$((FAIL + 1)); }
[ "$MAX_CONN" = "100" ] && PASS=$((PASS + 1)) || { echo "WRONG MAX_CONN: got '$MAX_CONN', expected '100'"; FAIL=$((FAIL + 1)); }

echo "Passed: $PASS / Failed: $FAIL"
[ "$FAIL" -eq 0 ] && REWARD=1

echo "$REWARD" > "$REWARD_FILE"
