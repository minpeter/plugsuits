#!/bin/bash
set -e

REWARD=0
PASS=0
FAIL=0
REWARD_FILE="/logs/verifier/reward.txt"
mkdir -p /logs/verifier

if [ ! -f /agent/work/audit_report.txt ]; then
    echo "MISSING: /agent/work/audit_report.txt"
    echo "$REWARD" > "$REWARD_FILE"
    exit 0
fi

check() {
    local line_num=$1 expected=$2 label=$3
    local actual
    actual=$(sed -n "${line_num}p" /agent/work/audit_report.txt | tr -d '[:space:]')
    if [ "$actual" = "$expected" ]; then
        echo "  PASS [$label]: $actual"
        PASS=$((PASS + 1))
    else
        echo "  FAIL [$label]: got '$actual', expected '$expected'"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Audit Report Verification ==="

check 1  "5432"                          "database port"
check 2  "6380"                          "redis port"
check 3  "super-secret-jwt-key-2024-prod" "jwt secret"
check 4  "10"                            "TODO/FIXME file count"
check 5  "users.py"                      "hardcoded password file"
check 6  "unsafe_hash"                   "deprecated function"
check 7  "250"                           "rate limit"
check 8  "8084"                          "notification port"
check 9  "myapp_products_v3"             "search index"
check 10 "https://app.example.com"       "cors origin"

echo ""
echo "Passed: $PASS / Failed: $FAIL"
[ "$FAIL" -eq 0 ] && REWARD=1

echo "$REWARD" > "$REWARD_FILE"
