---
"@ai-sdk-tool/cea": patch
---

Prevent PID recycling race in killProcessTree by checking activeProcesses before SIGKILL and clearing timeout in finish()
