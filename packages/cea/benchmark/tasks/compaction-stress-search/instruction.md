You are auditing a microservice codebase for configuration bugs and security issues.
The project has 15 source files spread across multiple directories.
Your context window is limited to 32000 tokens — you WILL need multiple rounds of reading.

IMPORTANT: Use tools (grep, shell_execute) for EVERY step. Do NOT guess file contents.
For files under /work/src/, use shell_execute (for example: cat, grep, sed) to inspect them.

══════════════════════════════════════
PHASE 1 — DISCOVERY (read all configs)
══════════════════════════════════════

Use shell_execute to read each of these files to understand the project structure:
  /work/src/config/database.json
  /work/src/config/redis.json
  /work/src/config/auth.json
  /work/src/config/services.json
  /work/src/config/logging.json

══════════════════════════════════════
PHASE 2 — CODE SEARCH (grep for bugs)
══════════════════════════════════════

Use grep or shell_execute with grep to find:
  A) All files containing "TODO" or "FIXME" — record each location and message
  B) All files referencing "password" or "secret" — check for hardcoded credentials
  C) All files with port numbers — verify they match the config files
  D) All files importing "unsafe_" functions — these are deprecated and must be found

══════════════════════════════════════
PHASE 3 — DEEP INSPECTION (read flagged files)
══════════════════════════════════════

Read EVERY source file found in Phase 2 that has issues (use shell_execute). The source files are:
  /work/src/services/auth.py
  /work/src/services/users.py
  /work/src/services/payments.py
  /work/src/services/notifications.py
  /work/src/services/search.py
  /work/src/middleware/rate_limiter.py
  /work/src/middleware/cors.py
  /work/src/middleware/logging.py
  /work/src/utils/crypto.py
  /work/src/utils/validators.py

══════════════════════════════════════
PHASE 4 — AUDIT REPORT (recall from memory)
══════════════════════════════════════

Write work/audit_report.txt with EXACTLY these answers, one per line:
  Line 1: The database port from database.json (just the number)
  Line 2: The Redis port from redis.json (just the number)
  Line 3: The JWT secret from auth.json (the exact string value)
  Line 4: The number of source files containing at least one TODO or FIXME (just the count of files)
  Line 5: The filename that contains a hardcoded password (just the filename, e.g. users.py)
  Line 6: The deprecated unsafe_ function name found in crypto.py (e.g. unsafe_hash)
  Line 7: The rate limit value from rate_limiter.py (just the number, requests per minute)
  Line 8: The notification service port from services.json (just the number)
  Line 9: The search service index name from search.py (the exact string)
  Line 10: The CORS allowed origin from cors.py (the exact URL string)
