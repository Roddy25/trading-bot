---
name: verify-frontend-change
description: Verify every UI change end to end before you call it done. Use this skill after any edit to a component, page, style, or route in a React or Next.js project. Use it even when the edit looks small.
---

# Verify frontend changes

Never report a UI change as done after a successful edit alone. Check it the way a human reviewer does.

1. Read the files you changed. Read the files next to them so you know the local patterns.
2. Run the static checks: lint, type check, and unit tests. Use the scripts in package.json.
3. Start the dev server. Open the edited page in the browser.
4. Use the change directly. Click each new control. Confirm the state change. Take a screenshot before and after.
5. Check the browser console. Zero new errors or warnings are allowed.
6. Check a phone width and a desktop width. Do not test desktop only.
7. Run a production build. It must pass.
8. If the Chrome DevTools MCP is connected, run a performance trace and audit Core Web Vitals.

If any step fails, fix the cause and restart from step 1. Do not hand back partly verified work.

## Report format

End with a short report:

- Files changed
- Checks run, with the result of each
- Checks skipped, with the reason for each

Name every skipped check. Silence about a check is not a pass.
