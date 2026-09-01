# Skill & MCP Manager

Index, search-rank, and conflict-detect AI Agent Skills, plus browse MCP servers and tools.

It scans `SKILL.md` files across local directories and MCP configs from Cursor (and related tools), then provides **keyword ranking**, **trigger-word conflict analysis**, and **MCP tool browse/search**.

---

## Overview

When an AI agent (Cursor / Claude) has dozens or hundreds of Skills, two problems show up:

1. **Wrong Skill** — the user says “upgrade BBU,” but `bbu-sw-upgrade` and `nokia-bbu-sw-upgrade` share triggers, so the model may pick the old one.
2. **Missed Skill** — ranking is poor, so the real match sits too far down.

This tool:

- **Indexes** every SKILL.md name / description / triggers / content
- **Ranks** queries with a TF-IDF-like multi-field score
- **Detects trigger overlap** with Jaccard similarity

---

## Features

| Feature | Description |
|------|------|
| Multi-directory Skill scan | Recursively scans configured roots (cursor-builtin / cursor-skills / claude-skills / local projects, etc.), finds every `SKILL.md`, skips `node_modules` and similar |
| YAML front matter | Extracts `name` and `description` (including `>-` folded scalars) |
| Trigger extraction | Regex over the full text (触发词, auto-trigger, Use when, triggers) |
| Keyword ranking | TF-IDF-like: name(10) > trigger(6) > description(4) > content(1.5), phrase bonus, Chinese unigram/bigram tokens |
| **LLM semantic search** | `claude -p` matches natural language (e.g. “run the case” → nokia-robot-case) with a reason. Keyword prefilter top 40 → dedupe → LLM picks 1–5, typically 8–15s |
| Search mode switch | Keyword / AI. AI mode checks Claude SDK availability and falls back to keywords |
| Conflict detection | O(n²) pairs, Jaccard, overlapping triggers + fix suggestions |
| Severity | High (≥0.5) / medium (≥0.3) / low (≥0.15), filterable |
| Cross-source flag | Conflicts across directories (e.g. claude-skills vs cursor-local) are marked separately (highest risk) |
| **Same-category filter** | Relation filter **🎯 same category** shows only pairs in the same functional category — those are the ones an agent actually confuses. Cards get a “same category” tag; the summary counts them |
| Fix suggestions | Text generated from source, deprecated flags, and similarity |
| Web UI | Dark single-page app: Skill list on the left, Search / Conflicts tabs on the right |
| Index cache | 30s in-memory TTL |
| Example query chips | Nine typical queries, one click |
| MCP server browse | Multi-source: `~/.cursor/projects/*/mcps/` (with schema) + `~/.cursor/mcp.json` + Claude / Gemini / project mcp.json + Cursor plugins, then dedupe. **Sources are customizable in `mcp-dirs.json`** (set a key to `[]` to disable it) |
| **MCP static analysis** | For `command=python/node` + local `.py`/`.js`, scan `@mcp.tool()`, `server.tool(...)`, `add_tool(...)`, extract tool name + line + docstring **offline**. UI tags these as “static analysis” |
| Three tool-count sources | ① Cursor cached schema (exact, with params) ② static analysis (names + descriptions) ③ 0 tools (HTTP MCP or uvx/npx packages → use 🔍 Debug / Inspector at runtime) |
| MCP tool search | Keyword rank on tool name/description; also server-level search for servers without tool schema |
| MCP tool params | Name, type, required (Cursor schema source only) |
| **Built-in Probe (recommended)** | 📡 Probe on each server card: spawn the process → MCP JSON-RPC `initialize` + `tools/list` → parse stdout → runtime tools, serverInfo, param schema. **Bypasses Inspector**: no SSE, no Windows backslash bug, no concurrent crash, no extra UI. 15s timeout; failures return stderr |
| MCP Inspector | 🔍 Debug launches `npx @modelcontextprotocol/inspector` with dynamic ports, live logs, and child cleanup. Inspector on Windows has a path bug (`\` eaten in `args`); prefer 📡 Probe |
| Skill / MCP view switch | Top-left button |
| **Author mark** | Visible “by amize” (title, sidebar footer, main-pane badge) |
| **Skill category tree** | Sidebar **📂 Category** vs **📦 Source**. Category groups (Nokia BTS / Feishu / knowledge / dev tools / system / browser / AI agent / media / Cursor builtin) with icons, counts, collapse. Priority: SKILL.md front matter `category:` > name prefix > exact rules table |
| **UI language** | Sidebar `中 / EN`, persisted in localStorage (`data-i18n` + dictionary) |
| **Content translation** | 🌐 “译为中文” / “Translate to EN” on descriptions, MyMemory free API (no key). Auto-detect source language; restore original in one click. Failures keep original + red error |
| **Proxy** | Backend uses `HTTPS_PROXY` / `HTTP_PROXY` via HTTP CONNECT. Shortcuts: `npm run dev:proxy` / `npm run start:proxy` |
| **Click a Skill card** | Modal: ① view SKILL.md source, or ② learning-guide visualization. Source viewer hits `/api/skill/content` and a zero-dependency markdown renderer. Top buttons: “📂 Open in editor” (`/api/skill/open`) and “📋 Copy path”. ESC / overlay closes. The 🌐 button does not open the viewer |
| **Skill learning guide (skill-visualizer)** | Bundled [skill-visualizer](https://github.com/Gtato-ai/skill-visualizer) in `skill-visualizer/`. Generates a beginner Chinese learning-guide HTML (6 modules: purpose / file tree / runtime flow / core files / master lens / learning path). Open in an iframe modal; “open in new tab” / “regenerate” |
| **Background viz generation** | After startup, generate learning-guide HTML one Skill at a time (concurrency configurable, default 1). If not ready, UI shows “generating / queue position” and polls. User-clicked Skills jump to the front of the queue |
| **Viz incremental update** | On startup, compare `SKILL.md` vs HTML mtime: missing HTML → generate; SKILL.md newer → regenerate; otherwise reuse cache in `viz-cache/` (gitignored) |

---

## Tech stack

| Piece | Tech | Version |
|------|------|------|
| Backend | Node.js + Express | express ^4.18.2 |
| CORS | cors | ^2.8.5 |
| File scan | Node.js `fs` (recursive) | built-in |
| Frontend | Vanilla HTML/CSS/JS (single-file SPA) | — |
| Style | Dark inline CSS | — |
| Glob | glob | ^10.3.10 |
| YAML | gray-matter | ^4.0.3 |
| LLM semantic pick | Claude CLI (`claude -p`) | Claude Code CLI required |
| Skill visualization | bundled skill-visualizer + Claude CLI + Python `build-report.py` | needs `claude` on PATH |
| Online translation | MyMemory Translation API (free, no key) | via HTTP CONNECT proxy |
| Cross-platform env | cross-env | ^7.x (npm scripts only) |
| LLM Python bridge | Python 3.11+ subprocess | built-in |

---

## Quick start

### Install

```bash
git clone https://github.com/sgamiza/mcp_skill_manager.git
cd mcp_skill_manager
npm install
```

### Run

All npm scripts set env via `cross-env`. You do **not** need to `set` / `$env:` each time.

```bash
# Direct network (default SKILL_VIZ_AUTO=0, generate viz on demand)
npm start
npm run dev          # watch / auto-restart

# Corporate network (HTTP proxy so translation / viz / AI can reach the internet)
npm run start:proxy
npm run dev:proxy

# Generate every Skill learning guide in the background at startup (SKILL_VIZ_AUTO=1; slow, has API cost)
npm run start:auto          # direct
npm run dev:proxy:auto      # proxy + full generate + watch
```

Then open http://localhost:3791

> **`SKILL_VIZ_AUTO`:** scripts default to `SKILL_VIZ_AUTO=0` (generate only the Skill you click). Use `start:auto` / `dev:proxy:auto`, or temporarily `cross-env SKILL_VIZ_AUTO=1 ...`, for full batch. See [Skill learning guide](#skill-learning-guide-visualization).
>
> **Proxy:** `*:proxy` scripts use placeholder `http://YOUR_PROXY:8080`. Replace `YOUR_PROXY` in `package.json` before use. Direct networks should use scripts without `:proxy`. See [CONFIGURATION.md](CONFIGURATION.md).

#### npm scripts

| Script | Proxy | Auto-restart | Viz auto-generate |
|------|------|---------|----------------|
| `npm start` | no | no | off (on demand) |
| `npm run dev` | no | yes | off (on demand) |
| `npm run start:proxy` | yes `YOUR_PROXY` (replace) | no | off (on demand) |
| `npm run dev:proxy` | yes `YOUR_PROXY` (replace) | yes | off (on demand) |
| `npm run start:auto` | no | no | on (full) |
| `npm run dev:proxy:auto` | yes `YOUR_PROXY` (replace) | yes | on (full) |

> `node server.js` works, but it does not apply the script presets for proxy / `SKILL_VIZ_AUTO`.

### Network bind

Default bind is `127.0.0.1` (localhost only).

To allow LAN access (e.g. `http://10.x.x.x:3791`), edit the bottom of `server.js`:

```javascript
// before (localhost only)
const BIND_HOST = '127.0.0.1';

// after (LAN)
const BIND_HOST = '0.0.0.0';
```

Restart. If it still cannot be reached, allow the port in Windows Firewall (admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Skill & MCP Manager" -Direction Inbound -LocalPort 3791 -Protocol TCP -Action Allow
```

Set it back to `127.0.0.1` when you no longer need LAN access.

### pm2 (recommended for always-on)

`npm start` dies when the terminal closes or the process crashes. Use **pm2**.

```
┌─────────────────────────────────────────────────────────┐
│  System startup                                         │
│    └─→ pm2 daemon (stays in memory)                     │
│            └─→ skill-selector (server.js child)         │
│                    ↑ daemon restarts on crash           │
└─────────────────────────────────────────────────────────┘
```

| Mechanism | Meaning |
|------|------|
| **Daemon** | Survives closing the terminal |
| **Auto restart** | Non-zero exit → immediate restart |
| **`pm2 save`** | Serialize the process list to `~/.pm2/dump.pm2` |
| **`pm2 startup`** | Inject OS startup (Windows registry / Linux systemd) so the daemon comes back and restores `dump.pm2` |
| **Logs** | stdout/stderr under `~/.pm2/logs/`, rotatable |

```powershell
npm install -g pm2

cd <repo-root>
pm2 start server.js --name skill-selector

pm2 save
pm2 startup
```

```powershell
pm2 list
pm2 logs skill-selector
pm2 logs skill-selector --lines 50
pm2 restart skill-selector
pm2 stop skill-selector
pm2 delete skill-selector
```

### Configure Skill and MCP directories

Defaults expand from `%USERPROFILE%` / `$HOME`.

**Skills — `skill-dirs.json` (no code change):**

```json
{
  "dirs": [
    { "root": "~/.cursor/skills-cursor", "label": "cursor-builtin" },
    { "root": "~/.cursor/skills",        "label": "cursor-skills" },
    { "root": "~/.claude/skills",        "label": "claude-skills" },
    { "root": "~/projects",              "label": "local-projects", "skipDirs": [".cursor", ".claude"] }
  ]
}
```

**MCP sources — `mcp-dirs.json`:**

```json
{
  "projectRoots": ["~/.cursor/projects"],
  "configFiles":  ["~/.cursor/mcp.json", "~/.claude/.mcp.json"],
  "scriptDirs":   ["~/.claude/mcp"],
  "pluginRoots":  ["~/.cursor/plugins/cache"]
}
```

Set a key to `[]` to disable that source — e.g. `"scriptDirs": []` skips `~/.claude/mcp`. Delete the file to fall back to built-in defaults.

Both lists are editable in the UI (bottom-left): “⚙️ Edit Skill scan dirs” and “🔌 Edit MCP scan dirs”. Save applies **immediately, no restart**.

See [CONFIGURATION.md](CONFIGURATION.md) for every knob.

### Skill categories (Skill tree)

Past ~100 Skills, a flat list is hard to browse. Tree view groups by function.

**Priority:**

1. **Front matter `category:` (highest)**

```yaml
---
name: nokia-bts-status
category: nokia
description: ...
---
```

2. **Name prefix** — `nokia-*` → nokia, `feishu-*` → feishu, `llm-wiki*` → knowledge
3. **Exact rules table** — Skills that break the prefix rule (e.g. `lmi-eth-enable` → nokia) live in `CATEGORY_EXACT_RULES` in `server.js`

| Category | Icon | Meaning |
|------|------|------|
| nokia | 📡 | Nokia BTS/BBU/RRU operations |
| feishu | 💬 | Feishu bots |
| knowledge | 📚 | Knowledge bases (llm-wiki, memory, RAG) |
| dev-tools | 🛠️ | Dev tools (Git, build, Jira, workflow) |
| system | 💻 | System (lock screen, backup, SSH, camera) |
| browser | 🌐 | Browser automation and search |
| ai-agent | 🤖 | AI agents (MetaBot, CDP, Grill) |
| media | 🎵 | Media (voice, PDF, resume) |
| cursor-builtin | ⚡ | Cursor built-in Skills |
| other | 📦 | Uncategorized |

---

## Skill learning guide (visualization)

Bundled [skill-visualizer](https://github.com/Gtato-ai/skill-visualizer) turns a Skill folder into a beginner Chinese learning-guide HTML (six modules: purpose / file tree / runtime flow / core files / master lens / learning path).

### How to use

1. Click a Skill card in search results → “choose how to view.”
2. Pick “Skill learning guide (visualization)”:
   - Already generated → iframe immediately; “open in new tab” or “regenerate.”
   - Not ready → “generating / queue position,” auto-poll, then swap to HTML. Your click jumps that Skill to the front of the queue.

### How it works

```
Start server
  └─ initViz(): scan all Skills
        ├─ HTML exists and is fresh → mark done (no AI call)
        └─ missing / SKILL.md newer than HTML → enqueue
  └─ generate in background (concurrency default 1):
        skill_visualizer_gen.py
          1. Read skill-visualizer rules (SKILL.md + references)
          2. Read all text files in the target Skill folder
          3. Call claude CLI for report data (delimiter format, so large HTML does not break JSON)
          4. skill-visualizer/scripts/build-report.py merges data + fixed skeleton
          5. Write viz-cache/<source>__<name>.html
```

### Incremental update

| Situation | Action |
|------|------|
| No HTML | Generate |
| SKILL.md mtime > HTML mtime | Regenerate |
| SKILL.md unchanged | Skip, reuse cache |

If you edit a Skill’s `SKILL.md` while the server runs, the next visualization open detects staleness and re-queues.

### Environment variables

| Variable | Code default | npm-script default | Meaning |
|------|-----------|-------------|------|
| `SKILL_VIZ_AUTO` | `1` (on) | `0` (off, see `package.json`) | `1` = batch all at startup; `0` = on demand. `npm start`/`dev`/`*:proxy` preset `0`; `start:auto`/`dev:proxy:auto` use `1` |
| `SKILL_VIZ_CONCURRENCY` | `1` | `1` | Parallel generations. Higher is faster, more rate-limit risk |
| `SKILL_VIZ_TIMEOUT` | `300` | `300` | Per-Skill timeout seconds |

> In code, unset `SKILL_VIZ_AUTO` means on (`1`). Common `package.json` scripts force `0` via `cross-env` so startup does not call AI for every Skill.
>
> ⚠️ `start:auto` / `dev:proxy:auto` (`SKILL_VIZ_AUTO=1`) calls AI once per Skill on first run (about 1–3 minutes each). Later starts only handle new/changed Skills.
>
> Requires `claude` CLI on PATH; otherwise auto-generate stops and the UI shows why.

---

## API

### Skill API

| Method | Path | Meaning | Params |
|------|------|------|------|
| GET | `/api/skills` | List Skills (includes category/categoryLabel) | — |
| GET | `/api/skill-categories` | Ordered category stats | — |
| POST | `/api/search` | Ranked search, top 18 | body: `{ "query": "..." }` |
| GET | `/api/skill/content` | Raw SKILL.md (name/source/filePath/mtime/size) | query: `id=...` |
| POST | `/api/skill/open` | Open SKILL.md with the OS default app (Win: `start` / macOS: `open` / Linux: `xdg-open`) | body: `{ "id": "..." }` |
| GET | `/api/skill/visualization` | Learning-guide status (`queued`/`generating`/`done`/`error`); on-demand enqueue + move to front; stale SKILL.md re-queue | query: `id=...` |
| GET | `/api/skill/visualization/html` | Generated HTML (409 if not ready) | query: `id=...` |
| POST | `/api/skill/visualization/regenerate` | Force regenerate, ignore cache | body: `{ "id": "..." }` |
| GET | `/api/viz/stats` | Overall viz progress | — |
| GET | `/api/stats` | Skill counts by source and category | — |
| GET | `/api/conflicts` | Conflict detection | query: `threshold=0.15` |

### MCP API

| Method | Path | Meaning | Params |
|------|------|------|------|
| GET | `/api/mcp/servers` | List servers (no tool/resource details) | — |
| GET | `/api/mcp/server/:id` | Full server (tools + resources) | `:id` |
| GET | `/api/mcp/server?id=...` | Query-string form (ids containing `/`) | `id` |
| POST | `/api/mcp/search` | Search tools + servers, top 20 (`resultType: 'tool'\|'server'`) | body: `{ "query": "..." }` |
| GET | `/api/mcp/stats` | Server / tool / resource counts | — |
| GET | `/api/mcp/config?id=...` | Raw config (mcp.json / SERVER_METADATA.json) + path, size, mtime | `id` |
| **POST** | **`/api/mcp/probe`** | **Built-in probe — spawn server, JSON-RPC `initialize`+`tools/list`, runtime tools** | body: `{ "id": "..." }` |
| POST | `/api/mcp/inspect` | Start Inspector (Windows path bug) | body: `{ "id": "..." }` |
| GET | `/api/mcp/inspect/status` | Inspector child status, URL, logs | query: `id?` |
| POST | `/api/mcp/inspect/stop` | Stop an Inspector child | body: `{ "id": "..." }` |

#### POST `/api/mcp/probe`

**Goal:** runtime tool list over stdio JSON-RPC, no Inspector.

```
1. Read { command, args, env } from mcp.json and spawn (stdio)
2. stdin JSON-RPC: {"method":"initialize", "params":{"protocolVersion":"2024-11-05", ...}}
3. Parse stdout → serverInfo (name, version)
4. Send notifications/initialized
5. JSON-RPC: {"method":"tools/list"}
6. Parse full tools array (name, description, inputSchema)
7. SIGKILL the child and return
```

**Request**

```json
{ "id": "ssh-tools" }
```

**Success**

```json
{
  "ok": true,
  "command": "python",
  "args": ["/path/to/your/ssh_mcp.py"],
  "serverInfo": { "name": "ssh-tools", "version": "1.27.0" },
  "tools": [
    {
      "name": "ssh_exec",
      "description": "Run one shell command on a remote Linux host over SSH...",
      "inputSchema": {
        "type": "object",
        "properties": {
          "host": { "type": "string" },
          "username": { "type": "string" }
        },
        "required": ["host", "username", "password", "command"]
      }
    }
  ],
  "stderr": "..."
}
```

**Failure**

```json
{
  "ok": false,
  "error": "process exited (code=1 signal=null) before completing handshake",
  "exitCode": 1,
  "command": "python",
  "args": ["..."],
  "stderr": "ModuleNotFoundError: No module named 'mcp'"
}
```

| Source | How | Accuracy | Limits |
|------|------|--------|------|
| ① **Cursor schema cache** | `~/.cursor/projects/.../mcps/<server>/tools/*.json` | Full schema | Only after Cursor has started that server |
| ② **Static analysis** | `@mcp.tool()`, `server.tool(...)`, etc. | Names + docstring | Local .py/.js only; does not prove the server starts |
| ③ **Probe runtime** (recommended) | Actually start the server | Runtime tools + schema | Server must start (deps, env) |

Probe extras: prove the process starts (stderr on failure), full JSON Schema, dynamically registered tools, `serverInfo`, no Windows Inspector path bug.

Default timeout **15s**. Any step failure → `{ ok: false, error, stderr }`; UI shows the command plus the last 2 KB of stderr. The child is `SIGKILL`ed before the response returns.

### LLM semantic search API

| Method | Path | Meaning | Params |
|------|------|------|------|
| POST | `/api/llm-search` | Claude semantic search (keyword prefilter → LLM pick) | body: `{ "query": "..." }` |
| GET | `/api/llm/status` | Is Claude CLI available? | — |

**POST /api/llm-search**

```json
{
  "results": [
    {"name": "nokia-robot-case", "score": 95, "reason": "user wants to run automation test cases", "source": "cursor-skills", "filePath": "...", "description": "..."}
  ],
  "error": null,
  "fallback": false,
  "latencyMs": 8136
}
```

`fallback: true` means LLM unavailable/timeout; keyword search was used.

### Translation API

| Method | Path | Meaning | Params |
|------|------|------|------|
| POST | `/api/translate` | Online translation (MyMemory, no key) | body: `{ "text": "...", "target": "zh"\|"en" }` |

Source language is auto-detected (CJK character ratio). `target` must be `zh` or `en`. Max 500 characters per call (truncated). Internal LRU cache of 5000 entries. Corporate networks: set `HTTPS_PROXY` at startup.

**Success**

```json
{ "ok": true, "translated": "Run one shell command on a remote Linux host", "sourceLang": "en", "provider": "mymemory" }
```

**Failure**

```json
{ "ok": false, "error": "MyMemory: HTTP 503", "sourceLang": "en", "hint": "Translation provider failed. Original text is preserved on UI." }
```

The UI button turns red (`⚠ translation failed`), shows the error on hover, and restores after 3.5s. Original text is always kept.

### Other

| Method | Path | Meaning |
|------|------|------|
| GET | `/` | Frontend |

### Response examples

**POST /api/search**

```json
[
  {
    "id": "cursor-local/nokia-bbu-sw-upgrade",
    "name": "nokia-bbu-sw-upgrade",
    "description": "Upgrade Nokia BBU software to the latest version...",
    "triggers": ["upgrade BBU", "BBU software upgrade"],
    "source": "cursor-local",
    "filePath": "~/.cursor/skills/nokia-bbu-sw-upgrade/SKILL.md",
    "score": 42.5
  }
]
```

**GET /api/conflicts**

```json
[
  {
    "skillA": { "id": "...", "name": "bbu-sw-upgrade", "source": "claude-skills" },
    "skillB": { "id": "...", "name": "nokia-bbu-sw-upgrade", "source": "cursor-local" },
    "similarity": 0.583,
    "sharedTriggers": ["upgrade bbu"],
    "severity": "high",
    "fix": "\"bbu-sw-upgrade\" looks like a legacy Skill; consider stating in its description that \"nokia-bbu-sw-upgrade\" replaces it"
  }
]
```

---

## Project structure

```
mcp_skill_manager/
├── server.js                 # Express: index, scoring, conflicts, LLM search, viz scheduler
├── llm_selector.py           # Semantic picker via claude CLI -p
├── skill_visualizer_gen.py   # Per-Skill learning guide: claude CLI + build-report.py
├── index.html                # Single-file SPA
├── skill-visualizer/         # Bundled skill-visualizer (SKILL.md + references + scripts/build-report.py)
├── viz-cache/                # Learning-guide HTML cache (gitignored, <source>__<name>.html)
├── package.json
├── package-lock.json
├── skill-dirs.json           # Skill scan directories
├── mcp-dirs.json             # MCP scan sources
├── .gitignore
├── README.md                 # This file
├── CONFIGURATION.md          # Proxy, paths, ports
├── ARCHITECTURE.md           # Code map, extension, refactor notes
└── node_modules/             # gitignored
```

---

## Core algorithms

### Search score (`scoreSkill`)

```
Input: skill object + query string
Output: numeric score (higher = better)

1. Tokenize the query:
   - split on whitespace / punctuation
   - Chinese segments: unigram + bigram + original segment; drop stopwords
   - English: drop tokens of length ≤ 1
   - dedupe
2. For each token, score 4 fields:
   - name contains token     → +10
   - name equals token       → extra +5
   - description occurrences → +4 each
   - trigger contains token  → +6
   - content occurrences     → +1.5 each (cap 5)
3. Phrase bonus:
   - description/trigger contains the full query → +15
   - content contains the full query             → +8
```

### LLM semantic search (`claude -p`)

```
Input: user query
Output: 1–5 best Skills with score + reason

1. Prefilter: scoreSkill() on the full index, take top 40
2. Dedupe: same name from different sources → keep one
3. Prompt: system + Skill list (name + description[:100] + triggers[:5])
4. claude -p: non-interactive, --bare (skip hooks/LSP), --no-session-persistence
5. Parse JSON: [{name, score, reason}], object arrays or string arrays
6. Enrich from the index: source, filePath, description, triggers
7. On timeout/failure, fall back to keyword search
```

### Conflict detection (Jaccard)

```
For each pair (A, B):
1. Keyword sets from trigger tokens + description tokens
2. Jaccard = |A∩B| / |A∪B|
3. Bands:
   - ≥ 0.50 → high
   - ≥ 0.30 → medium
   - ≥ 0.15 → low
4. Fix text (deprecated, cross-source, …)
```

---

## Common operations

### Add a Skill scan directory

Edit `SKILL_DIRS` in `server.js`:

```javascript
{ root: 'D:\\my-skills', label: 'my-custom' },
```

Then add matching keys in `groups` and `containers` inside `renderSidebar` in `index.html`, plus a CSS badge class (see `.badge-cursor-skills`). Prefer `skill-dirs.json` / the UI editor so you do not need a code change.

### Tune ranking weights

Constants inside `scoreSkill` in `server.js`:

- name: `10` / `5`
- description: `4`
- trigger: `6`
- content: `1.5` (cap `5`)
- phrase: `15` / `8`

### Tune conflict threshold

Frontend default `threshold=0.15` in `loadConflicts()` in `index.html`. The backend also accepts the URL query.
