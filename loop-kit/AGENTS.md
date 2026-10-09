# AI Engineering Loop Kit

Use a maker/checker workflow for coding tasks.

## Core workflow
1. Define a measurable goal and machine-checkable stop condition.
2. Read relevant code and nearby files before editing.
3. For bugs, reproduce the issue before changing code.
4. Make the smallest defensible change; avoid unrelated refactors.
5. Run relevant checks after changes.
6. Have a fresh-context verifier review the diff and evidence.
7. Never call work complete merely because a build passes if the requested behavior can be tested directly.
8. Read and update `LOOP_STATE.md` for recurring work.

## Verification
- UI changes: use `.agents/skills/verify-frontend-change/SKILL.md`.
- Bug queues: use `.agents/skills/triage-bug-reports/SKILL.md`.
- A verifier must not edit application code.
- An implementer must not declare its own work correct.

## Safety and scope
- Do not modify secrets, credentials, or production data.
- Do not add dependencies unless required.
- Do not rewrite unrelated code.
- Changes touching auth, payments, migrations, destructive operations, or user data require human review unless explicitly authorized.
- If required information is missing, ask one precise question rather than guessing.
