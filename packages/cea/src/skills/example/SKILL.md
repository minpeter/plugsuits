---
name: example
description: Example v2 skill demonstrating agentskills.io standard with subdirectories
license: MIT
compatibility: Works on all platforms
metadata:
  author: minpeter
  version: 1.0.0
allowed-tools: shell_execute(*) read_file(*)
---

# Example Skill (v2 Format)

This is an example skill using the agentskills.io v2 standard format.

## Features

- Demonstrates YAML frontmatter parsing
- Shows directory-based structure with subdirectories
- Includes scripts and reference files

## Usage

1. Load this skill using `load_skill("example")`
2. Access subdirectory files using `load_skill("example", "scripts/setup.sh")`
3. Reference documentation at `references/api.md`

## Available Resources

### Scripts
- `scripts/setup.sh` - Setup script for initializing the environment

### References
- `references/api.md` - API documentation

## Example Commands

```bash
# Run setup script
./scripts/setup.sh

# Check API documentation
cat references/api.md
```
