# AI Loop Starter Kit — Portable Edition

This kit started as a Claude Code loop kit and has been adapted for multiple coding agents.

| Tool | Configuration |
|---|---|
| OpenAI Codex | `AGENTS.md`, `.agents/skills/`, `.codex/agents/*.toml` |
| Claude Code | `.claude/skills/`, `.claude/agents/` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Cursor | `.cursor/rules/loop-kit.mdc` |
| Windsurf | `.windsurf/rules/loop-kit.md` |
| Cline | `.clinerules/loop-kit.md` |
| Gemini CLI | `GEMINI.md` |

The portable workflow uses three ideas: reproduce first, separate implementation from verification, and use machine-checkable stop rules.

## Install

Copy the contents of this kit into the root of your project.

For Codex, start from the project root. It can load `AGENTS.md`, repository skills under `.agents/skills`, and project custom agents under `.codex/agents`.

For Claude Code, keep the `.claude` directory.

For other clients, use the corresponding adapter file. These adapters avoid relying on client-specific slash commands.

The kit does not grant an AI agent permissions it does not already have. Browser automation, GitHub access, MCP servers, terminals, and scheduled execution depend on the client and its configured tools.
