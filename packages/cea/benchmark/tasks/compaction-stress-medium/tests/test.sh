#!/bin/bash
set -e

REWARD=0
PASS=0
FAIL=0
REWARD_FILE="/logs/verifier/reward.txt"
mkdir -p /logs/verifier

# Check files exist
for f in /agent/work/calc.js /agent/work/calc.test.js /agent/work/index.js; do
    if [ -f "$f" ]; then
        PASS=$((PASS + 1))
    else
        echo "MISSING: $f"
        FAIL=$((FAIL + 1))
    fi
done

# Run the actual tests
if node /agent/work/calc.test.js 2>&1 | grep -q "ALL TESTS PASSED"; then
    PASS=$((PASS + 1))
    echo "calc.test.js: PASSED"
else
    echo "calc.test.js: FAILED"
    FAIL=$((FAIL + 1))
fi

# Check summary.txt
if [ ! -f /agent/work/summary.txt ]; then
    echo "MISSING: /agent/work/summary.txt"
    echo "$REWARD" > "$REWARD_FILE"
    exit 0
fi

FUNC=$(sed -n '1p' /agent/work/summary.txt | tr -d '[:space:]')
RESULT=$(sed -n '2p' /agent/work/summary.txt | tr -d '[:space:]')

[ "$FUNC" = "add" ] && PASS=$((PASS + 1)) || { echo "WRONG FUNC: '$FUNC' expected 'add'"; FAIL=$((FAIL + 1)); }
[ "$RESULT" = "300" ] && PASS=$((PASS + 1)) || { echo "WRONG RESULT: '$RESULT' expected '300'"; FAIL=$((FAIL + 1)); }

echo "Passed: $PASS / Failed: $FAIL"
[ "$FAIL" -eq 0 ] && REWARD=1

echo "$REWARD" > "$REWARD_FILE"
