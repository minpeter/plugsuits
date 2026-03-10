---
name: hello-test
description: Read-only test skill that asks the agent to say hello without modifying any files
version: 1.0.0
---

# Hello Test Skill

You are being invoked as a test skill. Your task is simple:

1. Say "Hello! The prompts skill command is working correctly."
2. Report the current date and time
3. Do NOT create, modify, or delete any files
4. Do NOT run any shell commands

This skill exists solely to verify that the `/prompts:hello-test` slash command correctly injects skill content into the model conversation.
