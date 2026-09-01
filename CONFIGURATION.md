# Configuration Guide / 配置指南

本文档说明 MCP Skill Manager 中所有需要根据你的环境自定义的配置项。

---

## 1. Skill 扫描目录

### 方法 A：直接编辑 `skill-dirs.json`（推荐，无需重启代码）

编辑项目根目录下的 `skill-dirs.json`，然后在 UI 里保存或重启服务器即可。

```json
{
  "dirs": [
    { "root": "~/.cursor/skills-cursor", "label": "cursor-builtin" },
    { "root": "~/.cursor/skills",        "label": "cursor-skills" },
    { "root": "~/.claude/skills",        "label": "claude-skills" },
    { "root": "~/projects",              "label": "local-projects",  "skipDirs": [".cursor", ".claude"] },
    { "root": "D:/my-team-skills",       "label": "team-skills" }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `root` | ✅ | 目录路径，支持 `~` 展开为用户主目录 |
| `label` | ✅ | 来源标签，决定 UI 里显示的分类名 |
| `skipDirs` | 可选 | 扫描时跳过的子目录名列表（如 `[".cursor", ".claude"]`） |

也可以直接在 UI 左下角点「⚙️ 编辑 Skill 扫描目录」按钮，在弹窗里添加/删除目录并保存（无需重启，即时生效）。

### 方法 B：环境变量（临时追加）

通过 `SKILL_EXTRA_DIRS` 可以在不修改 `skill-dirs.json` 的情况下临时追加目录：

```bash
# Linux / macOS
export SKILL_EXTRA_DIRS="/path/to/project1;/path/to/project2"

# Windows PowerShell
$env:SKILL_EXTRA_DIRS = "C:\my-projects;D:\other-skills"

# Windows CMD
set SKILL_EXTRA_DIRS=C:\my-projects;D:\other-skills
```

---

## 2. MCP 扫描来源

### 方法 A：编辑 `mcp-dirs.json`（推荐，无需改代码）

**文件:** `server.js` → `loadMcpDirs()` 读取项目根目录下的 `mcp-dirs.json`。路径支持 `~`：

```json
{
  "projectRoots":   ["~/.cursor/projects"],
  "descriptorDirs": [],
  "configFiles":    ["~/.cursor/mcp.json", "~/.claude/.mcp.json"],
  "scriptDirs":     ["~/.claude/mcp"],
  "pluginRoots":    ["~/.cursor/plugins/cache"]
}
```

| 键 | 对应来源 | 说明 |
|----|----------|------|
| `projectRoots` | Cursor 项目 mcps | 每个根按 `<root>/<project>/mcps/<server>/` 扫描（含完整 schema） |
| `descriptorDirs` | 扁平描述符目录 | 直接按 `<dir>/<server>/` 扫描，适合自定义/打包的 mcps 目录 |
| `configFiles` | mcp.json / .mcp.json | 解析这些文件里的 `mcpServers` |
| `scriptDirs` | 自定义脚本 | 扫描目录下 `.py/.js/.ts` 并静态提取工具 |
| `pluginRoots` | Cursor 插件市场 | 按 `<root>/<vendor>/<plugin>/mcp.json` 扫描 |

**收窄/关闭某来源**：把对应键设为 `[]`。例如不想扫描 `~/.claude/mcp`，就写 `"scriptDirs": []`。删掉整个 `mcp-dirs.json` 则回退到内置默认（即上面的值）。

也可以直接在 UI 左下角点「🔌 编辑 MCP 扫描目录」按钮，弹窗按 6 类（projectRoots / descriptorDirs / configFiles / scanDirs / scriptDirs / pluginRoots）分组增删路径并保存（走 `GET/POST /api/mcp-dirs`，**无需重启，即时重新扫描生效**）。

### 方法 B：环境变量 `MCP_SCAN_DIRS` 追加项目目录

若某些项目目录下散落着 `mcp.json` / `.mcp.json`，用 `MCP_SCAN_DIRS`（分号分隔）递归查找并追加：

```bash
# Linux / macOS
export MCP_SCAN_DIRS="/home/me/projects;/home/me/work"

# Windows PowerShell
$env:MCP_SCAN_DIRS = "C:\my-projects;D:\work"
```

> 在 `mcp-dirs.json` 里显式写了 `scanDirs` 键时会覆盖 `MCP_SCAN_DIRS`；省略该键则使用此环境变量。

---

## 3. HTTP 代理（企业网络）

**文件:** `package.json` → `scripts`，`server.js` → 翻译 API 代理

如果你的网络需要 HTTP 代理才能访问外部 API（如翻译服务），需要配置代理地址。

### 方法 A: 修改 package.json

编辑 `package.json` 中的 `start:proxy` 和 `dev:proxy` 脚本，将 `YOUR_PROXY` 替换为你的代理地址：

```json
{
  "scripts": {
    "start:proxy": "cross-env HTTP_PROXY=http://your-proxy-ip:port HTTPS_PROXY=http://your-proxy-ip:port node server.js",
    "dev:proxy": "cross-env HTTP_PROXY=http://your-proxy-ip:port HTTPS_PROXY=http://your-proxy-ip:port node --watch server.js"
  }
}
```

### 方法 B: 通过环境变量

```bash
# Linux / macOS
export HTTP_PROXY=http://your-proxy-ip:port
export HTTPS_PROXY=http://your-proxy-ip:port
npm run dev

# Windows PowerShell
$env:HTTP_PROXY = "http://your-proxy-ip:port"
$env:HTTPS_PROXY = "http://your-proxy-ip:port"
npm run dev

# Windows CMD
set HTTP_PROXY=http://your-proxy-ip:port
set HTTPS_PROXY=http://your-proxy-ip:port
npm run dev
```

如果不需要代理，直接使用 `npm start` 或 `npm run dev` 即可。

---

## 4. 服务器绑定地址

**文件:** `server.js` → `BIND_HOST`

默认绑定到 `127.0.0.1`（仅本机可访问）。如果需要局域网内其他设备访问：

```js
const BIND_HOST = '0.0.0.0';  // 允许局域网访问
```

> 注意：修改为 `0.0.0.0` 后，同网段的其他设备可以通过你的 IP 地址访问此服务。如需限制，请配置防火墙规则。

---

## 5. 端口号

**文件:** `server.js` → `PORT`

默认端口为 `3791`。如需更改：

```js
const PORT = 3791;  // 修改为你想要的端口
```

---

## 6. LLM 语义搜索（可选）

**文件:** `llm_selector.py`

AI 语义搜索功能依赖 `claude` CLI。需要满足：

1. 已安装 Claude CLI（`claude` 命令可用）
2. Claude API 有可用额度（免费额度可能不足）

如果不需要 AI 搜索，关键词搜索仍然可用，系统会自动回退。

---

## 7. 环境变量汇总

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `SKILL_EXTRA_DIRS` | 额外的 Skill 扫描目录（分号分隔） | `C:\projects;D:\skills` |
| `MCP_SCAN_DIRS` | 额外的 MCP 配置扫描目录（分号分隔） | `C:\projects;D:\work` |
| `HTTP_PROXY` | HTTP 代理地址 | `http://proxy:8080` |
| `HTTPS_PROXY` | HTTPS 代理地址 | `http://proxy:8080` |

---

## 快速验证

启动后控制台会打印加载的 Skill 和 MCP 数量：

```
🎯 Skill & MCP Manager running at http://localhost:3791  (bound to 127.0.0.1)
📦 Loaded 45 skills from 3 directories
🔌 Loaded 12 MCP servers with 30 tools
```

如果数字为 0，请检查对应目录路径是否正确。
