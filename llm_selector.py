"""
llm_selector.py — 用 claude CLI 做语义 Skill 选择

通过 stdin 接收 JSON 输入，调用 claude -p 做语义匹配，stdout 输出 JSON 结果。

输入格式: {"query": "...", "skills": [{"name": "...", "description": "...", "triggers": [...]}]}
输出格式: {"results": [{"name": "...", "score": 85, "reason": "..."}], "error": null}
"""

import json
import os
import re
import subprocess
import sys

SYSTEM_PROMPT = """你是一个 AI Agent Skill 路由器。给定用户任务和 Skill 列表，选最匹配的 1-5 个。
理解语义："跑case"="执行自动化测试"，"发飞书"="feishu send"。
必须返回 JSON 对象数组，每个对象有 name、score(0-100)、reason(中文一句话)。只返回 score>=50 的。
示例输出：[{"name":"nokia-robot-case","score":95,"reason":"用户要跑自动化测试case"}]
直接返回 JSON，不要用 markdown 代码块包裹。"""


def build_prompt(user_query: str, skills: list) -> str:
    lines = [f"## 用户任务\n{user_query}\n\n## 可用 Skills（共 {len(skills)} 个）\n"]
    for i, s in enumerate(skills, 1):
        desc = (s.get("description") or "")[:100]
        triggers = ", ".join((s.get("triggers") or [])[:5])
        line = f"{i}. **{s['name']}** — {desc}"
        if triggers:
            line += f" | 触发词: {triggers}"
        lines.append(line)
    lines.append('\n请选出最匹配的 Skill，返回 JSON 对象数组 [{"name":"...","score":0-100,"reason":"..."}]：')
    return "\n".join(lines)


def extract_json(text: str) -> list:
    text = re.sub(r"```(?:json)?\s*", "", text).replace("```", "").strip()
    match = re.search(r"\[[\s\S]*\]", text)
    if not match:
        return []
    parsed = json.loads(match.group())
    if not isinstance(parsed, list):
        return []
    result = []
    for item in parsed:
        if isinstance(item, str):
            result.append({"name": item, "score": 80, "reason": "LLM selected"})
        elif isinstance(item, dict) and "name" in item:
            result.append(item)
    return result


def run_selection(user_query: str, skills: list) -> dict:
    prompt = build_prompt(user_query, skills)

    try:
        result = subprocess.run(
            [
                "claude", "-p",
                "--system-prompt", SYSTEM_PROMPT,
                "--output-format", "text",
                "--dangerously-skip-permissions",
                "--no-session-persistence",
                "--bare",
                prompt,
            ],
            capture_output=True,
            text=True,
            timeout=80,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
    except subprocess.TimeoutExpired:
        return {"results": [], "error": "Claude CLI timed out (80s)"}
    except FileNotFoundError:
        return {"results": [], "error": "claude CLI not found in PATH"}
    except Exception as e:
        return {"results": [], "error": str(e)}

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "unknown error")[:300]
        return {"results": [], "error": f"claude exit {result.returncode}: {err}"}

    raw_output = result.stdout.strip()
    try:
        results = extract_json(raw_output)
        if not isinstance(results, list):
            results = []
        results = [r for r in results if isinstance(r, dict) and "name" in r]
        results.sort(key=lambda r: r.get("score", 0), reverse=True)
        return {"results": results, "error": None}
    except (json.JSONDecodeError, ValueError) as e:
        return {"results": [], "error": f"JSON parse failed: {e}\nRaw: {raw_output[:500]}"}


def main():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8")
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        json.dump({"results": [], "error": f"Invalid input: {e}"}, sys.stdout, ensure_ascii=False)
        return

    user_query = data.get("query", "")
    skills = data.get("skills", [])

    if not user_query:
        json.dump({"results": [], "error": "Empty query"}, sys.stdout, ensure_ascii=False)
        return

    result = run_selection(user_query, skills)
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
