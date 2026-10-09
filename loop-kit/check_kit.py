#!/usr/bin/env python3
import pathlib, re, sys
root = pathlib.Path(__file__).parent
errors = []

def frontmatter(path):
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m: return None
    fields={}
    for line in m.group(1).splitlines():
        if ":" in line:
            k,v=line.split(":",1); fields[k.strip()]=v.strip()
    return fields

for base in (root/".claude/skills", root/".agents/skills"):
    for skill in sorted(base.glob("*/SKILL.md")):
        f=frontmatter(skill)
        if f is None: errors.append(f"{skill}: missing frontmatter"); continue
        if f.get("name") != skill.parent.name: errors.append(f"{skill}: name mismatch")
        if len(f.get("description","")) < 40: errors.append(f"{skill}: description too short")

for agent in sorted((root/".claude/agents").glob("*.md")):
    f=frontmatter(agent)
    if f is None: errors.append(f"{agent}: missing frontmatter"); continue
    if f.get("name") != agent.stem: errors.append(f"{agent}: name mismatch")

for agent in sorted((root/".codex/agents").glob("*.toml")):
    text=agent.read_text(encoding="utf-8")
    for field in ("name =", "description =", "developer_instructions ="):
        if field not in text: errors.append(f"{agent}: missing {field}")

verifier = root/".claude/agents/verifier.md"
if verifier.exists() and re.search(r"\b(Edit|Write)\b", (frontmatter(verifier) or {}).get("tools","")):
    errors.append("Claude verifier must not have Edit or Write tools")

for name in ("AGENTS.md","LOOP_STATE.md","LOOPS.md","README.md","GEMINI.md"):
    p=root/name
    if not p.exists() or not p.read_text(encoding="utf-8").strip(): errors.append(f"{name}: missing or empty")

if errors:
    print("FAIL"); print("\n".join(errors)); sys.exit(1)
print("PASS: portable AI loop kit is valid")
