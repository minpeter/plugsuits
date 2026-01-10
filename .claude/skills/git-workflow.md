# Git Workflow Skill

## Overview

This skill provides comprehensive guidance for git operations, branch management, commit creation, and **GitHub Pull Request creation using GitHub CLI**.

## Core Responsibilities

1. **Branch Management** - Create, switch, and manage feature branches
2. **Commit Operations** - Stage changes and create meaningful commits
3. **Push Operations** - Push branches to remote repository
4. **Pull Request Creation** - Create PRs using GitHub CLI (`gh pr create`)
5. **Workflow Completion** - Ensure full cycle from changes to PR

## Available Tools

- `shell_execute` - Execute git and gh CLI commands
- `read_file` - Read git config, commit messages, PR templates
- `grep` - Search for patterns in git history
- `glob` - Find git-related files

## Git Command Reference

### Safe Commands (Always OK)
```bash
git status                    # Check working tree status
git branch                    # List branches
git log                       # View commit history
git diff                      # Show changes
git show                      # Show commit details
gh pr list                    # List pull requests
gh pr view                    # View PR details
```

### Careful Commands (Require Verification)
```bash
git checkout -b <branch>      # Create new branch
git add .                     # Stage all changes
git commit -m "message"       # Create commit
git push -u origin <branch>   # Push new branch
gh pr create                  # Create pull request
```

### Dangerous Commands (Require Explicit User Confirmation)
```bash
git push --force              # Force push (NEVER on main/master)
git reset --hard              # Discard changes permanently
git rebase                    # Rewrite history
git push --delete             # Delete remote branch
```

## Workflow Patterns

### Standard Feature Workflow

When user requests "create PR" or "make a pull request":

**Step 1: Check Current State**
```bash
git status
git branch
```

**Step 2: Create Feature Branch (if needed)**
```bash
# Branch naming conventions:
# - feature/description
# - fix/issue-description
# - refactor/component-name
# - docs/topic

git checkout -b feature/descriptive-name
```

**Step 3: Stage Changes**
```bash
git add .
# Or selectively:
git add src/specific/file.ts
```

**Step 4: Create Descriptive Commit**
```bash
# Commit message format:
# <type>: <short description>
#
# <detailed explanation if needed>
#
# Types: feat, fix, refactor, docs, test, chore

git commit -m "feat: add user authentication system

- Implement JWT token generation
- Add login/logout endpoints
- Create auth middleware"
```

**Step 5: Push to Remote**
```bash
git push -u origin feature/descriptive-name
```

**Step 6: Create Pull Request**
```bash
# Basic PR creation:
gh pr create --base main --head feature/descriptive-name \
  --title "Add user authentication system" \
  --body "## Summary
- Implements JWT-based authentication
- Adds login/logout endpoints
- Includes auth middleware

## Testing
- All tests passing
- Manual testing completed"

# Interactive PR creation (if user wants to review):
gh pr create --web
```

### Quick Commit and PR Workflow

For simple changes where user says "commit and create PR":

```bash
# All in one flow:
git add .
git commit -m "fix: resolve authentication bug"
git push -u origin fix/auth-bug
gh pr create --base main --title "Fix authentication bug" --body "Resolves issue with token expiration"
```

### PR Creation Options

**Option 1: Direct Creation (Recommended)**
```bash
gh pr create \
  --base main \
  --head feature/branch-name \
  --title "Clear, descriptive title" \
  --body "## Summary
What changed and why

## Changes
- Bullet point list
- Of key changes

## Testing
How it was tested"
```

**Option 2: Interactive Web UI**
```bash
gh pr create --web
# Opens browser for user to fill in details
```

**Option 3: Using PR Template**
```bash
# If .github/pull_request_template.md exists:
gh pr create --base main --fill
# Automatically uses template
```

### Checking PR Status

After creating PR:
```bash
# Get PR URL and status:
gh pr view

# Check CI status:
gh pr checks

# List all PRs:
gh pr list
```

## Branch Naming Conventions

Follow these patterns:
- `feature/user-auth` - New features
- `fix/login-bug` - Bug fixes
- `refactor/api-client` - Code refactoring
- `docs/readme-update` - Documentation
- `test/auth-coverage` - Test additions
- `chore/deps-update` - Maintenance tasks

## Commit Message Guidelines

### Format
```
<type>: <subject>

<body>

<footer>
```

### Types
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code restructuring
- `docs` - Documentation changes
- `test` - Test additions/changes
- `chore` - Maintenance tasks
- `perf` - Performance improvements
- `style` - Code style changes (formatting)

### Examples

**Good:**
```
feat: add GitHub OAuth integration

- Implement OAuth flow
- Add callback handler
- Store tokens securely

Closes #123
```

**Bad:**
```
update stuff
```

## PR Description Template

When creating PR, use this structure:

```markdown
## Summary
Brief overview of what changed and why

## Changes
- Key change 1
- Key change 2
- Key change 3

## Testing
- [ ] Unit tests added/updated
- [ ] Manual testing completed
- [ ] All tests passing

## Related Issues
Closes #123
Relates to #456
```

## Safety Guardrails

### NEVER Do These Without Explicit User Confirmation:
1. `git push --force` on main/master branch
2. `git reset --hard` (loses uncommitted changes)
3. Delete remote branches that others might use
4. Rebase commits that have been pushed
5. Amend commits that have been pushed

### ALWAYS Do These:
1. Check `git status` before committing
2. Review `git diff` before staging
3. Use descriptive commit messages
4. Push to feature branch, not main
5. Create PR instead of pushing directly to main

## Error Handling

### Common Issues and Solutions

**Issue: "gh: command not found"**
```bash
# Solution: Install GitHub CLI
# macOS:
brew install gh

# Linux:
# See: https://github.com/cli/cli/blob/trunk/docs/install_linux.md

# Then authenticate:
gh auth login
```

**Issue: "failed to push some refs"**
```bash
# Solution: Pull latest changes first
git pull origin main
# Resolve conflicts if any
git push
```

**Issue: "not a git repository"**
```bash
# Solution: Initialize git repo
git init
git remote add origin <repo-url>
```

**Issue: "gh: Not authenticated"**
```bash
# Solution: Login to GitHub
gh auth login
# Follow interactive prompts
```

## Complete Example Workflow

User says: "이 변경사항들을 PR로 올려줘"

**AI Response:**
```bash
# Step 1: Check current state
git status

# Step 2: Create feature branch (if on main)
git checkout -b feature/implement-todo-system

# Step 3: Stage all changes
git add .

# Step 4: Create commit
git commit -m "feat: implement todo system with auto-resume

- Add todo_write and todo_read tools
- Implement auto-continuation middleware
- Update system prompts for autonomous execution
- Add session-based todo isolation"

# Step 5: Push branch
git push -u origin feature/implement-todo-system

# Step 6: Create PR
gh pr create \
  --base main \
  --title "Implement todo system with auto-resume functionality" \
  --body "## Summary
Adds a comprehensive todo system that enables AI to track and automatically continue incomplete tasks.

## Changes
- Created todo_write and todo_read tools
- Built auto-continuation middleware
- Updated system prompts for autonomous execution
- Implemented session-based todo isolation

## Testing
- All unit tests passing (7/7)
- TypeScript compilation clean
- Linting passing
- Manual testing completed in CLI mode"

# Step 7: Report success
echo "✅ Pull request created successfully!"
gh pr view --web
```

## Integration with Other Skills

This skill works with:
- **Shell Execution** - All git/gh commands use `shell_execute`
- **File Reading** - Read commit templates, PR templates
- **Todo System** - Mark "create PR" tasks as complete after success

## Key Principles

1. **Complete the Cycle** - Don't stop at commit; create the PR
2. **Descriptive Messages** - Commits and PRs should explain WHY, not just WHAT
3. **Safety First** - Never force push to main, always use feature branches
4. **User Visibility** - Report each step and final PR URL
5. **Autonomous Execution** - Don't ask user to run commands; execute them

## When to Use This Skill

Trigger phrases:
- "create a PR"
- "make a pull request"
- "commit and push"
- "올려줘" / "PR 만들어줘"
- "push these changes"
- "create PR from these changes"

## Expected Outcomes

After using this skill:
- ✅ Changes committed with descriptive message
- ✅ Branch pushed to remote
- ✅ Pull request created on GitHub
- ✅ PR URL provided to user
- ✅ User can review PR in browser
