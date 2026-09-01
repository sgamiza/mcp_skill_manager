"""
skill_visualizer_gen.py — 为单个 Skill 生成「Skill 学习导览」单页 HTML

流程（对应 skill-visualizer 的工作原理）：
  1. 读取 skill-visualizer 的规则文件（SKILL.md + references）
  2. 读取目标 Skill 文件夹的全部文本文件
  3. 调用 claude CLI，让它按规则产出报告数据
  4. 运行 skill-visualizer/scripts/build-report.py，把数据 + 固定骨架合成 HTML

为避免「大段 HTML 塞进 JSON 字符串」导致 JSON 非法，这里让模型用「分隔符格式」输出：
  - 小块结构化数据（meta / file_data / flow_steps）用 JSON
  - 每个模块的大段 HTML 用原文，靠 ###SECTION### 分隔，本脚本再拼回 build-report 需要的 dict

用法：
  python skill_visualizer_gen.py --skill-dir <目标skill目录> --name <skill名> --output <html路径>
        [--visualizer-dir <skill-visualizer目录>] [--timeout 240]

成功 exit 0，stdout 打印 {"ok": true, "output": "...", "bytes": 12345}
失败 exit 1，stdout 打印 {"ok": false, "error": "..."}
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

# Windows 控制台默认 cp1252，强制 utf-8 避免打印中文崩溃
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))

TEXT_EXTS = {
    ".md", ".py", ".js", ".ts", ".mjs", ".cjs", ".json", ".txt", ".sh",
    ".html", ".css", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".robot",
}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
MAX_FILE_CHARS = 12000
MAX_TOTAL_TARGET_CHARS = 60000

MODULE_ORDER = ["purpose", "file_structure", "execution_flow", "core_file", "master_insights", "learning_path"]


def read_text(path, limit=None):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = f.read()
        return data[:limit] if limit else data
    except Exception:
        return ""


def dump_target_skill(skill_dir):
    chunks = []
    total_files = 0
    total_lines = 0
    total_chars = 0
    for root, dirs, files in os.walk(skill_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in sorted(files):
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, skill_dir).replace("\\", "/")
            ext = os.path.splitext(fn)[1].lower()
            total_files += 1
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                total_lines += content.count("\n") + 1
            except Exception:
                content = ""
            if ext not in TEXT_EXTS:
                chunks.append(f"\n===== 文件: {rel} (二进制/非文本，已跳过内容) =====\n")
                continue
            if total_chars >= MAX_TOTAL_TARGET_CHARS:
                chunks.append(f"\n===== 文件: {rel} (已达总量上限，内容省略) =====\n")
                continue
            snippet = content[:MAX_FILE_CHARS]
            if len(content) > MAX_FILE_CHARS:
                snippet += f"\n... (文件过长，已截断，共 {content.count(chr(10)) + 1} 行) ..."
            total_chars += len(snippet)
            chunks.append(f"\n===== 文件: {rel} =====\n{snippet}\n")
    return "".join(chunks), total_files, total_lines


OUTPUT_FORMAT_SPEC = """## 输出格式（必须严格遵守，否则无法解析）

按下面的「分隔符格式」输出，不要用 markdown 代码块包裹，不要任何额外说明文字。
顺序固定：先 META，再 FILE_DATA，再 FLOW_STEPS，再 6 个 SECTION，最后 END。

###META###
{"name":"<skill名>","total_files":<数字>,"total_lines":<数字>}
###FILE_DATA###
{"SKILL.md":{"role":"entry","lines":200,"color":"#D94F30","summary":"中文摘要","value":"key"}, "...其它文件...":{...}}
###FLOW_STEPS###
[{"title":"第 1 步：触发识别","read":"读取什么","judge":"判断什么","output":"产出什么","files":[["#D94F30","SKILL.md"]]}]
###SECTION### {"type":"purpose","nav_title":"用途","title":"这个 Skill 是做什么的","subtitle":"一句话看懂它的用途"}
<这里是该模块的 HTML 片段，可多行，复用骨架 CSS 类名，全中文，内容真实>
###SECTION### {"type":"file_structure","nav_title":"文件结构","title":"...","subtitle":"..."}
<HTML...>
###SECTION### {"type":"execution_flow","nav_title":"运行流程","title":"...","subtitle":"..."}
<HTML...>
###SECTION### {"type":"core_file","nav_title":"核心文件","title":"...","subtitle":"..."}
<HTML...>
###SECTION### {"type":"master_insights","nav_title":"大师视角","title":"...","subtitle":"..."}
<HTML...>
###SECTION### {"type":"learning_path","nav_title":"学习路线","title":"...","subtitle":"..."}
<HTML...>
###END###

格式硬性要求：
- META / FILE_DATA / FLOW_STEPS 三行后面紧跟的必须是合法 JSON（可压缩成一行）。
- 每个 ###SECTION### 标记同一行后面跟该模块的元信息 JSON（只含 type/nav_title/title/subtitle）。
- ###SECTION### 之后、下一个 ###SECTION###（或 ###END###）之前的所有内容，都是该模块的 HTML 原文，不要做 JSON 转义。
- 6 个 SECTION 的 type 必须依次为：purpose, file_structure, execution_flow, core_file, master_insights, learning_path。
- 各种 ### 标记必须独占一行的行首。HTML 内容里不要出现以 ### 开头的行。
"""


def build_input(visualizer_dir, skill_name, skill_dir):
    rules = read_text(os.path.join(visualizer_dir, "SKILL.md"))
    design = read_text(os.path.join(visualizer_dir, "references", "design-system.md"))
    interactive = read_text(os.path.join(visualizer_dir, "references", "interactive-elements.md"))
    target_dump, total_files, total_lines = dump_target_skill(skill_dir)

    parts = [
        "# 任务：为目标 Skill 生成「Skill 学习导览」报告数据",
        "",
        "你是 skill-visualizer。请严格遵循下面《生成规则》分析《目标 Skill》，按指定《输出格式》产出报告数据。",
        f"skill 名称：{skill_name}；建议 total_files={total_files}，total_lines={total_lines}（可据实微调）。",
        "",
        OUTPUT_FORMAT_SPEC,
        "",
        "=" * 60,
        "## 生成规则（skill-visualizer/SKILL.md）",
        "=" * 60,
        rules,
        "",
        "=" * 60,
        "## 设计系统（references/design-system.md）",
        "=" * 60,
        design,
        "",
        "=" * 60,
        "## 交互组件（references/interactive-elements.md）",
        "=" * 60,
        interactive,
        "",
        "=" * 60,
        f"## 目标 Skill：{skill_name}（目录：{skill_dir}）",
        "=" * 60,
        target_dump,
        "",
        "=" * 60,
        "请现在按《输出格式》输出报告数据（从 ###META### 开始，到 ###END### 结束）：",
    ]
    return "\n".join(parts), total_files, total_lines


SYSTEM_PROMPT = (
    "你是 skill-visualizer 报告数据生成器。阅读用户提供的生成规则、设计系统与目标 Skill 文件，"
    "严格按用户指定的「分隔符格式」输出报告数据。不要解释，不要 markdown 代码块。"
)


def call_claude(stdin_text, timeout):
    try:
        result = subprocess.run(
            [
                "claude", "-p",
                "--system-prompt", SYSTEM_PROMPT,
                "--output-format", "text",
                "--dangerously-skip-permissions",
                "--no-session-persistence",
                "--bare",
                "请阅读输入内容（含生成规则、设计系统、目标 Skill 文件），严格按「分隔符格式」输出报告数据，从 ###META### 到 ###END###。",
            ],
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
    except subprocess.TimeoutExpired:
        return None, f"claude CLI 超时（{timeout}s）"
    except FileNotFoundError:
        return None, "claude CLI 未找到（不在 PATH）"
    except Exception as e:
        return None, str(e)

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "unknown error")[:400]
        return None, f"claude 退出码 {result.returncode}: {err}"
    return result.stdout, None


def _loads_relaxed(s):
    """解析一段 JSON；失败时去掉尾随逗号再试一次。"""
    s = s.strip()
    try:
        return json.loads(s)
    except Exception:
        repaired = re.sub(r",(\s*[}\]])", r"\1", s)
        return json.loads(repaired)


def parse_delimited(raw):
    """解析模型输出的分隔符格式，返回 build-report 需要的 data dict。"""
    if not raw:
        raise ValueError("模型输出为空")
    # 去掉可能存在的 markdown 代码块围栏
    text = raw.replace("```json", "").replace("```", "")
    lines = text.split("\n")

    meta = {}
    file_data = {}
    flow_steps = []
    sections = []

    i = 0
    n = len(lines)

    def collect_until_marker(start):
        buf = []
        j = start
        while j < n and not lines[j].lstrip().startswith("###"):
            buf.append(lines[j])
            j += 1
        return "\n".join(buf).strip(), j

    while i < n:
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith("###META###"):
            block, i = collect_until_marker(i + 1)
            if block:
                try:
                    meta = _loads_relaxed(block)
                except Exception:
                    meta = {}
            continue
        if stripped.startswith("###FILE_DATA###"):
            block, i = collect_until_marker(i + 1)
            if block:
                try:
                    file_data = _loads_relaxed(block)
                except Exception:
                    file_data = {}
            continue
        if stripped.startswith("###FLOW_STEPS###"):
            block, i = collect_until_marker(i + 1)
            if block:
                try:
                    flow_steps = _loads_relaxed(block)
                except Exception:
                    flow_steps = []
            continue
        if stripped.startswith("###SECTION###"):
            meta_json = stripped[len("###SECTION###"):].strip()
            sec = {}
            if meta_json:
                try:
                    sec = _loads_relaxed(meta_json)
                except Exception:
                    sec = {}
            html, i = collect_until_marker(i + 1)
            sec["html"] = html
            sections.append(sec)
            continue
        if stripped.startswith("###END###"):
            break
        i += 1

    if not sections:
        raise ValueError("未解析出任何 SECTION")

    data = {
        "name": meta.get("name"),
        "total_files": meta.get("total_files", 0),
        "total_lines": meta.get("total_lines", 0),
        "file_data": file_data if isinstance(file_data, dict) else {},
        "flow_steps": flow_steps if isinstance(flow_steps, list) else [],
        "sections": sections,
    }
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill-dir", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--visualizer-dir", default=os.path.join(HERE, "skill-visualizer"))
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--debug-raw", default="", help="把模型原始输出写到此文件（调试用）")
    args = parser.parse_args()

    if not os.path.isdir(args.skill_dir):
        print(json.dumps({"ok": False, "error": f"skill-dir 不存在: {args.skill_dir}"}, ensure_ascii=False))
        sys.exit(1)

    build_script = os.path.join(args.visualizer_dir, "scripts", "build-report.py")
    if not os.path.isfile(build_script):
        print(json.dumps({"ok": False, "error": f"build-report.py 不存在: {build_script}"}, ensure_ascii=False))
        sys.exit(1)

    stdin_text, total_files, total_lines = build_input(args.visualizer_dir, args.name, args.skill_dir)

    raw, err = call_claude(stdin_text, args.timeout)
    if err:
        print(json.dumps({"ok": False, "error": err}, ensure_ascii=False))
        sys.exit(1)

    if args.debug_raw:
        try:
            with open(args.debug_raw, "w", encoding="utf-8") as f:
                f.write(raw or "")
        except Exception:
            pass

    try:
        data = parse_delimited(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"解析失败: {e}", "raw": (raw or "")[:500]}, ensure_ascii=False))
        sys.exit(1)

    if not data.get("name"):
        data["name"] = args.name
    if not data.get("total_files"):
        data["total_files"] = total_files
    if not data.get("total_lines"):
        data["total_lines"] = total_lines

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    tmp_json = tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8",
        dir=os.path.dirname(os.path.abspath(args.output)),
    )
    try:
        json.dump(data, tmp_json, ensure_ascii=False)
        tmp_json.close()

        proc = subprocess.run(
            [sys.executable, build_script, "--data", tmp_json.name, "--output", args.output],
            capture_output=True, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        if proc.returncode != 0:
            print(json.dumps({"ok": False, "error": f"build-report 失败: {(proc.stderr or proc.stdout)[:400]}"}, ensure_ascii=False))
            sys.exit(1)
    finally:
        try:
            os.unlink(tmp_json.name)
        except Exception:
            pass

    try:
        size = os.path.getsize(args.output)
    except Exception:
        size = 0
    print(json.dumps({"ok": True, "output": args.output, "bytes": size, "sections": len(data["sections"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
