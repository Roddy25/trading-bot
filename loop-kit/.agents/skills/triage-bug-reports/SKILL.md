---
name: triage-bug-reports
description: Triage new bug reports one at a time. Reproduce the bug, fix simple ones, and escalate unclear or risky ones. Use this skill for scheduled bug triage, issue queues, feedback channels, or any request to work through a pile of reports.
---

# Triage bug reports

## Rules

1. Handle one issue per run. Never batch issues.
2. Read LOOP_STATE.md first. Skip every issue marked done or escalated.
3. Reproduce the bug before you touch code. Write the exact steps and the result you saw.
4. Never claim a fix from a passing build alone. The bug must stop reproducing.
5. Allow at most 3 fix attempts per issue. Then escalate.

## Steps

1. Pick the oldest open issue in the queue.
2. Reproduce it. If two tries fail, go to the escalation ladder.
3. Classify it.
   - Simple: one file or one component, clear cause, and a check exists.
   - Risky: touches auth, payments, user data, or a schema.
   - Unclear: missing steps or reports disagree.
4. For a simple bug, send the goal to the implementer subagent. Then send the result to the verifier subagent. Trust the verifier verdict, not the implementer.
5. Write the outcome to LOOP_STATE.md.

## Escalation ladder

1. Missing information: ask the reporter one specific question. Mark the issue waiting.
2. Two failed reproductions: label the issue needs-human. Add the steps you tried.
3. Risky area: label the issue needs-human. Make no code change.
4. Three failed fix attempts: label the issue needs-human. Add the diff of the best attempt.

## Output

End each run with one line: issue id, action taken, verdict, next step.
