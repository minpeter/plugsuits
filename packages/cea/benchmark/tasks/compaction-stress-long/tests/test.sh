#!/bin/bash
set -e

REWARD=0
PASS=0
FAIL=0
REWARD_FILE="/logs/verifier/reward.txt"
mkdir -p /logs/verifier

# Check required files exist
for f in /work/data/numbers.txt /work/data/words.txt /work/scripts/sum.py /work/scripts/count.py /work/scripts/combine.py; do
    if [ -f "$f" ]; then
        PASS=$((PASS + 1))
    else
        echo "MISSING: $f"
        FAIL=$((FAIL + 1))
    fi
done

# Run scripts to verify they work
if python3 /work/scripts/sum.py 2>&1 | grep -q "Sum:"; then
    PASS=$((PASS + 1))
else
    echo "sum.py failed"
    FAIL=$((FAIL + 1))
fi

# Check answers.txt
if [ ! -f /work/answers.txt ]; then
    echo "MISSING: /work/answers.txt"
    echo "$REWARD" > "$REWARD_FILE"
    exit 0
fi

SUM=$(sed -n '1p' /work/answers.txt | tr -d '[:space:]')
COUNT=$(sed -n '2p' /work/answers.txt | tr -d '[:space:]')
FIRST=$(sed -n '3p' /work/answers.txt | tr -d '[:space:]')
LAST=$(sed -n '4p' /work/answers.txt | tr -d '[:space:]')

# 42+17+99+5+73+28+61+14+88+33 = 460
[ "$SUM" = "460" ] && PASS=$((PASS + 1)) || { echo "WRONG SUM: '$SUM' expected '460'"; FAIL=$((FAIL + 1)); }
[ "$COUNT" = "5" ] && PASS=$((PASS + 1)) || { echo "WRONG COUNT: '$COUNT' expected '5'"; FAIL=$((FAIL + 1)); }
[ "$FIRST" = "apple" ] && PASS=$((PASS + 1)) || { echo "WRONG FIRST: '$FIRST' expected 'apple'"; FAIL=$((FAIL + 1)); }
[ "$LAST" = "elderberry" ] && PASS=$((PASS + 1)) || { echo "WRONG LAST: '$LAST' expected 'elderberry'"; FAIL=$((FAIL + 1)); }

echo "Passed: $PASS / Failed: $FAIL"
[ "$FAIL" -eq 0 ] && REWARD=1

echo "$REWARD" > "$REWARD_FILE"
