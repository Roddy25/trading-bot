# Portable AI loops

These prompts work across Codex, Claude Code, Cursor, Windsurf, Gemini CLI, Cline, and similar coding agents.

## Goal loop
Give the agent a measurable goal and an attempt cap:

    Goal: all tests pass and lint is clean.
    Stop after 5 attempts.
    On every attempt: inspect -> change -> test -> verify.
    Do not declare success without command output proving the goal.

## Bug loop
    Read LOOP_STATE.md.
    Pick one oldest open issue.
    Reproduce it before editing.
    If reproduced, implement the smallest fix.
    Run relevant checks.
    Have a fresh-context verifier review the result.
    Maximum 3 fix attempts. Escalate after that.
    Update LOOP_STATE.md.

## UI loop
    Apply the requested UI change.
    Run static checks.
    Start the app and exercise the changed flow.
    Check desktop and mobile widths.
    Check browser console.
    Run a production build.
    Report every check as PASS or SKIPPED with a reason.

Do not assume `/loop`, `/goal`, or `/schedule` exist: those are client-specific features.
