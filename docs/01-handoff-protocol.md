# Handoff Protocol — files, not conversations

Agents forget. Files do not. Every handoff in this team is a file on disk, in the repo, in git.

## Folder per feature

```
docs/features/007-recognition-wall/
  10-opportunity.md      ← PM
  20-requirements.md     ← Business Analyst
  30-design-notes.md     ← Full-Stack Engineer
  40-test-plan.md        ← Test Automation
  50-review.md           ← Techno-Functional Reviewer
  99-decision-log.md     ← anyone, append-only
```

Numbered so the order is obvious to a human skimming the folder six months later.

## Every artefact starts with the same header

```markdown
---
feature: 007-recognition-wall
artefact: requirements
author: hrms-business-analyst
date: 2026-08-24
status: draft | in-review | approved | superseded
inputs: [10-opportunity.md]
---
```

## The three rules

**1. Read your inputs first, completely.** An agent that starts writing before reading the upstream artefact is guessing. If an input file is missing, stop and say so — do not invent the upstream content.

**2. Never edit an upstream artefact.** Found a problem in the requirements while coding? Do not silently fix it. Append to `99-decision-log.md`:

```markdown
### 2026-08-24 — Q from hrms-fullstack-engineer to hrms-business-analyst
REQ-014 says leave balance shows "days remaining". For hourly staff in the
warehouse this should be hours. Which is it, or is it both?
Blocking: yes. Assumed for now: days for salaried, hours for hourly.
```

Then the BA answers in the same file, and updates the requirement. The trail survives.

**3. Every artefact ends with an explicit handoff block.**

```markdown
## Handoff
**To:** hrms-fullstack-engineer
**Ready:** yes
**Open questions blocking you:** none
**Open questions not blocking you:** Q-03 (recognition emoji set — cosmetic)
**Assumptions I made that you should challenge:** recognitions are public by
default; a private option exists but is not in this slice.
```

## Invoking an agent

Claude Code delegates to a subagent when your prompt matches its `description`, but the reliable way is to name it:

```
Use the hrms-business-analyst subagent to write requirements for
docs/features/007-recognition-wall/ based on 10-opportunity.md
```

Or run the whole chain with the slash command: `/feature recognition wall`

> **Verify on your setup:** the exact @-mention syntax and whether subagents can
> invoke each other differ across Claude Code versions. The file-based protocol
> above works either way, which is why it is built this way. Run `claude --help`
> and check your version's docs before relying on automatic chaining.
