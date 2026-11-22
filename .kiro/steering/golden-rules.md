# Golden Rules for Development

These rules MUST be adhered to at all times during development of the EventFeed product.

## Core Development Principles

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked
- No abstractions for single-use code
- No "flexibility" or "configurability" that wasn't requested
- No error handling for impossible scenarios
- If you write 200 lines and it could be 50, rewrite it

**Ask yourself**: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting
- Don't refactor things that aren't broken
- Match existing style, even if you'd do it differently
- If you notice unrelated dead code, mention it - don't delete it

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused
- Don't remove pre-existing dead code unless asked

**The test**: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan with verification steps.

## Additional Golden Rules

### 5. Root Cause Analysis

**Prioritize root cause analysis and fixing the root cause of a problem.**

Don't patch symptoms. Dig deep to understand and fix the underlying issue.

### 6. Break Tasks Down

**Break large tasks up into smaller bits which we can easily accomplish, test and then learn from.**

Small, testable increments let us validate assumptions and learn quickly.

### 7. Industry Standards

**Adhere to industry standards when it comes to security, scalability and reliability.**

Don't reinvent the wheel for solved problems. Use proven patterns.

### 8. Build Playbooks

**If a whole bunch of similar tasks are going to be repeated, make a playbook to learn and make future tasks easier.**

Document patterns and create reusable approaches for recurring work.

### 9. Karpathy Methodologies

**Adhere to Andrej Karpathy methodologies and principles.**

Focus on:
- Data quality over model complexity
- Simple baselines first
- Iterative improvement
- Understanding what works and why
- Building the right tools for the job

## Success Indicators

These guidelines are working if:
- Fewer unnecessary changes in diffs
- Fewer rewrites due to overcomplication
- Clarifying questions come before implementation rather than after mistakes
- Code is simple, focused, and easy to understand
- Each change has clear traceability to requirements

### 10. Windows Machine

**Make sure that terminals or commands ar viable for windows wsl**

The user uses a windows environment. Commands must be for powershell or windows wsl. That is the terminal/output environment where we will be running things. Windows Based.

### 10. Avoid silent sleeps

**Always use Write-Host "DONE"**

E.g Start-Sleep -Seconds 3; Write-Host "DONE"

---
inclusion: always
---