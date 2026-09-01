# Skill Learning Guide · Skill Visualizer

![License](https://img.shields.io/github/license/Gtato-ai/skill-visualizer?style=flat-square)
![Skill](https://img.shields.io/badge/Skill-Agent-111111?style=flat-square)
![Output](https://img.shields.io/badge/Output-single--page%20HTML-2A7B9B?style=flat-square)
![Lang](https://img.shields.io/badge/UI-Chinese--first-D94F30?style=flat-square)

Turn any Skill folder into a beginner-friendly Chinese **Skill learning guide** as a single HTML page. Use it to see what the Skill does, how to read its files, the runtime order of work, how well it is designed, and where to start if you want to change it.

## What it generates

One standalone HTML page with six Chinese modules:

| Module | Question it answers |
|------|-----------|
| 01 **What this Skill does** | What is it for? Which scenarios? What is the final output? |
| 02 **How to read the file tree** | What is each file responsible for? (groups + main path, not a constellation diagram) |
| 03 **How the Skill runs** | Runtime order? What each step reads / decides / produces? (static walkthrough) |
| 04 **Core file walkthrough** | Where should a learner start? What does each section of the entry file do? |
| 05 **Master-lens review** | Is it well designed? What are the principles? (three “masters” comment on the essence, chosen to match the Skill’s character) |
| 06 **Learning path and change advice** | How should a beginner read it? Where to change triggers / style / flow / scripts? Which changes are high risk? |

**Output is a single HTML file** — no extra dependencies, no install, offline-viewable and shareable.

## Report positioning

This is a **learning guide**, not a code audit:

- Chinese titles, labels, and explanations; avoid abstract English jargon
- Plain language, short sentences, conclusion first
- Prefer grouping, steps, and a main path over complex graphs
- Technical terms get beginner hover tips; low-value files are folded automatically
- Use emoji sparingly; keep the layout clean

## Install

Clone this repo into your Skill directory (for example Claude Code’s `~/.claude/skills/`):

```bash
git clone https://github.com/Gtato-ai/skill-visualizer.git ~/.claude/skills/skill-visualizer
```

Or send this to an AI agent that has shell access:

```text
Install skill-visualizer. Clone https://github.com/Gtato-ai/skill-visualizer into ~/.claude/skills/skill-visualizer, then confirm SKILL.md, scripts/, and references/ exist.
```

## Usage

1. Open any project that contains a Skill.
2. Use a trigger such as:
   - *"analyze this Skill"*
   - *"Skill visualization"*
   - *"help me understand this Skill"*
   - *"show the Skill flow"*
3. After a short wait, open `{skill-name}-学习导览.html` in a browser.

## How it works

1. The AI reads `SKILL.md` and analyzes the target Skill folder.
2. The AI writes a 5–15 KB `skill-data.json` (HTML content for the six modules).
3. `scripts/build-report.py` merges the fixed CSS/JS skeleton with that data into a complete HTML page.

```bash
python3 scripts/build-report.py --data skill-data.json --output {skill-name}-学习导览.html
```

The AI only needs to write about 10 KB of data. Layout, style, and interaction stay in the fixed skeleton, which keeps results stable.

## Project structure

```
skill-visualizer/
├── SKILL.md                      # Core instruction file (all generation rules)
├── README.md                     # This document
├── LICENSE                       # MIT
├── scripts/
│   └── build-report.py           # Builder: JSON data + fixed skeleton → HTML
└── references/
    ├── template-head.html        # Fixed CSS skeleton
    ├── template-scripts.html     # Fixed JS skeleton (interaction)
    ├── template-report.html      # Full sample report
    ├── design-system.md          # Color / type / spacing
    └── interactive-elements.md   # Interactive component patterns
```

## Design idea

> This is a Skill learning guide, not a file inventory.
> Use groups, steps, a main path, and plain Chinese so a beginner can understand a complex Skill.

## Acknowledgements

Inspired by [codebase-to-course](https://github.com/zarazhangrui/codebase-to-course), redesigned for Skill learning.

## License

[MIT](./LICENSE)
