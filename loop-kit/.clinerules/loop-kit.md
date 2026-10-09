# AI Loop Kit instructions

- Define a measurable goal and stop condition before making repeated attempts.
- For bugs, reproduce the issue before editing.
- Make the smallest defensible change.
- Run relevant checks after changes.
- Review the diff with fresh context before calling work complete.
- Never claim success from a build alone if the requested behavior can be tested directly.
- Read and update LOOP_STATE.md for recurring bug work.
- Do not edit secrets or production data.
- Avoid unrelated refactors and dependency additions.
- Escalate risky changes involving auth, payments, migrations, destructive actions, or user data unless explicitly authorized.
- If a check cannot be run, say SKIPPED and explain why.
