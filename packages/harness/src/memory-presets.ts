export interface MemoryPreset {
  extractionPrompt: string;
  template: string;
}

export const CHAT_MEMORY_PRESET: MemoryPreset = {
  template: `# User Profile
_Key facts about the user: name, preferences, background_

# Conversation Summary
_What has been discussed so far_

# Current Topic
_What is being discussed right now_

# Important Details
_Specific facts, decisions, or requests to remember_`,

  extractionPrompt: `You are a memory extraction agent. Analyze the recent conversation and update the session notes.

Current notes:
<current_notes>
{{currentNotes}}
</current_notes>

RULES:
- Update ONLY the content below each section header
- NEVER modify section headers (lines starting with #) or italic descriptions
- Be thorough: capture ALL user facts, preferences, and important details
- Keep each section concise but complete
- "User Profile" is the MOST important section — never lose user facts
- "Current Topic" should reflect the MOST RECENT discussion

Respond with the COMPLETE updated notes file (all sections, even unchanged ones).
Wrap your response in <memory>...</memory> tags.`,
};

export const CODE_MEMORY_PRESET: MemoryPreset = {
  template: `# Session Title
_Brief descriptive title_

# Current State
_What is actively being worked on_

# Task Specification
_What the user asked to build_

# Files and Functions
_Important files and their roles_

# Workflow
_Commands and processes_

# Errors and Corrections
_What went wrong and how it was fixed_

# Learnings
_What works, what doesn't_

# Worklog
_Step by step progress_`,

  extractionPrompt: `You are a memory extraction agent for a coding session. Analyze the recent conversation and update the session notes.

Current notes:
<current_notes>
{{currentNotes}}
</current_notes>

RULES:
- Update ONLY the content below each section header
- NEVER modify section headers (lines starting with #) or italic descriptions
- Keep "Task Specification" aligned with the latest explicit user request
- Keep "Current State" and "Worklog" focused on the most recent concrete progress
- In "Files and Functions", capture concrete file paths, symbols, and why they matter
- In "Workflow", record key commands, scripts, and repeatable processes
- In "Errors and Corrections", preserve failures and how they were resolved
- In "Learnings", keep durable constraints and implementation insights
- Preserve chronological order in "Worklog"
- Be concise but complete, prioritizing context needed to continue coding accurately

Respond with the COMPLETE updated notes file (all sections, even unchanged ones).
Wrap your response in <memory>...</memory> tags.`,
};
