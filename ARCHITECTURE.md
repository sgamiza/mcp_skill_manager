# ARCHITECTURE.md — 架构文档 & AI 维护指南

> 本文档面向 **AI Agent**（Cursor / Claude），用于理解代码结构、快速定位修改点、安全扩展功能。
> 人类开发者也可以参考。

---

## 1. 系统架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        浏览器 (index.html)                       │
│                                                                 │
│  ┌──────────┐  ┌───────────────────────┐  ┌──────────────────┐  │
│  │ Sidebar  │  │   Tab: Interactive     │  │ Tab: Conflict    │  │
│  │ 技能列表  │  │   Demo (搜索排序)      │  │ Analysis (冲突)  │  │
│  └──────────┘  └───────────────────────┘  └──────────────────┘  │
│       │              │ POST /api/search         │               │
│       │              ▼                          ▼               │
│       │   GET /api/skills            GET /api/conflicts         │
└───────┼──────────────┼──────────────────────────┼───────────────┘
        │              │                          │
        ▼              ▼                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Express Server (server.js)                   │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  buildIndex() │  │ scoreSkill() │  │ conflictDetection()  │  │
│  │  索引构建     │  │  评分算法     │  │  冲突检测            │  │
│  └──────┬───────┘  └──────────────┘  └──────────────────────┘  │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │ parseSkillFile│ ← 逐个解析 SKILL.md                          │
│  └──────┬───────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────────────────┐                       │
│  │         文件系统 (walkDir)             │                       │
│  │  ~/.cursor/skills-cursor/            │                       │
│  │  ~/.cursor/skills/                   │                       │
│  │  ~/.claude/skills/                   │                       │
│  └──────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 文件职责划分

### server.js（后端 · 307 行）

| 行范围 | 函数/区块 | 职责 | 修改频率 |
|--------|----------|------|---------|
| 1-9 | 模块引入 & 中间件 | Express 初始化 | 极少 |
| 12-19 | `SKILL_DIRS` + `WALK_SKIP_DIRS` | **扫描目录配置**（4 个来源）+ 跳过目录黑名单 — 添加新目录在这里改 | 偶尔 |
| 19-88 | `parseSkillFile()` | **SKILL.md 解析器** — 提取 name/desc/triggers | 中等 |
| 91-116 | `buildIndex()` + `walkDir()` | **索引构建** — 递归扫描 + 调用解析器 | 少 |
| 119-171 | `scoreSkill()` + `tokenize()` + `countOccurrences()` | **评分算法** — 搜索核心 | 中等 |
| 174-184 | 缓存逻辑 | 30s TTL 内存缓存 | 少 |
| 187-214 | API 路由 `/api/skills` `/api/search` `/api/stats` | REST 接口 | 少 |
| 217-294 | 冲突检测：`skillKeywordSet()` `jaccard()` `sharedTriggers()` `suggestFix()` | **冲突分析核心** | 中等 |
| 297-306 | 静态文件服务 + 启动监听 | 服务入口 | 极少 |

### index.html（前端 · 539 行）

| 行范围 | 区块 | 职责 |
|--------|------|------|
| 1-150 | `<style>` | 暗色主题 CSS，所有样式内联 |
| 152-305 | `<body>` HTML | 页面结构（sidebar + main + 两个 tab panel） |
| 307-536 | `<script>` | 前端逻辑（fetch API → render DOM） |

**script 区块细分：**

| 行范围 | 函数 | 职责 |
|--------|------|------|
| 308-309 | 全局变量 | `API` 地址, `allConflicts`, `currentTab` |
| 312-322 | `switchTab()` | Tab 切换逻辑 |
| 325-351 | `init()` | 页面初始化：加载 stats + skills + 冲突预取 |
| 353-381 | `renderStats()` `renderSidebar()` | 渲染统计条和侧边栏 |
| 384-433 | `doSearch()` `renderResults()` `renderCard()` | **搜索 Tab** — 发请求 + 渲染结果卡片 |
| 436-514 | `loadConflicts()` `renderConflicts()` `renderConflictCard()` | **冲突 Tab** — 加载 + 筛选 + 渲染冲突卡片 |
| 516-533 | 工具函数 | `badgeClass()` `setQuery()` `escHtml()` + 键盘事件 |

---

## 3. 数据流

### 3.1 搜索流程

```
用户输入查询 → doSearch()
    ↓
POST /api/search { query: "..." }
    ↓
server: getIndex() → 获取缓存/重建索引
    ↓
server: 对每个 skill 调用 scoreSkill(skill, query)
    ↓
server: 过滤 score>0 → 降序排序 → 取 top 18
    ↓
返回 JSON 数组 → renderResults() → 渲染 skill-card 网格
```

### 3.2 冲突检测流程

```
用户切换到冲突 Tab / 点击刷新
    ↓
GET /api/conflicts?threshold=0.15
    ↓
server: getIndex() → 获取索引
    ↓
server: O(n²) 两两循环:
  - skillKeywordSet(A)、skillKeywordSet(B)
  - jaccard(setA, setB)
  - if sim ≥ threshold → 记录冲突
    ↓
server: 对每个冲突调用 sharedTriggers() + suggestFix()
    ↓
server: 按 similarity 降序排序 → 返回
    ↓
前端: renderConflicts() → 可按 severity / source 筛选
```

### 3.3 索引构建流程

```
getIndex() 被调用
    ↓
检查缓存: (now - cacheTime > 30s)?
    ↓ 是
buildIndex():
  遍历 SKILL_DIRS → walkDir(root) 递归文件列表
    ↓
  筛选 basename === 'skill.md'
    ↓
  parseSkillFile(filePath, label):
    - 读文件 → 逐行扫描 YAML front-matter (name, description)
    - 正则提取触发词
    - 截取前 2000 字符作 content
    ↓
  返回 skills 数组，写入缓存
```

---

## 4. 核心数据结构

### Skill 对象

```typescript
interface Skill {
  id: string;          // "${source}/${name}"
  name: string;        // 从 YAML front-matter 或目录名派生
  description: string; // 截取前 200 字符
  triggers: string[];  // 最多 20 个触发词
  source: string;      // "cursor-skills" | "cursor-local" | "claude-skills"
  filePath: string;    // SKILL.md 绝对路径
  content: string;     // 前 2000 字符（仅后端用于评分，API 返回时剥离）
}
```

### Conflict 对象

```typescript
interface Conflict {
  skillA: { id: string; name: string; source: string };
  skillB: { id: string; name: string; source: string };
  similarity: number;      // 0~1 Jaccard 系数
  sharedTriggers: string[]; // 重叠触发词（最多 8 个）
  severity: 'high' | 'medium' | 'low';
  fix: string;             // 修复建议文本
}
```

---

## 5. 扩展指南

### 5.1 添加新的 Skill 来源

**需改 2 个文件：**

1. **server.js** — `SKILL_DIRS` 数组添加新条目：
   ```javascript
   { root: '/path/to/new/skills', label: 'my-source' },
   ```

2. **index.html** — 3 处修改：
   - HTML: 在 `<aside class="sidebar">` 中添加新的 section：
     ```html
     <div class="sidebar-section">
       <div class="sidebar-label">My Source</div>
       <div id="sidebar-mysource"></div>
     </div>
     ```
   - CSS: 添加 badge 颜色类：
     ```css
     .badge-my-source{background:#1a3525;color:#4acf7a}
     ```
   - JS: 在 `renderSidebar()` 的 `groups` 和 `containers` 对象中添加：
     ```javascript
     groups['my-source'] = [];
     containers['my-source'] = 'sidebar-mysource';
     ```
   - JS: 在 `renderCard()` 和 `badgeClass()` 的映射中添加条目

### 5.2 修改评分权重

修改 `server.js` 中 `scoreSkill()` 函数内的常量：

```javascript
// 当前权重:
name 包含 token     → 10
name 完全等于 token  → 5 (额外)
description 出现    → 4 × 出现次数
trigger 包含        → 6
content 出现        → 1.5 × min(出现次数, 5)
短语匹配(desc/trig) → 15
短语匹配(content)   → 8
```

**注意**: 修改后需通过多个测试查询验证排序合理性，尤其关注：
- 同义 Skill（如 bbu-sw-upgrade vs nokia-bbu-sw-upgrade）的排序差异
- 中英文混合查询的表现

### 5.3 改进 SKILL.md 解析器

当前解析器 `parseSkillFile()` 存在的局限和改进方向：

| 局限 | 改进方式 |
|------|---------|
| 手写 YAML 解析（不支持嵌套） | 改用 `gray-matter` 库（已在依赖中，但代码未使用） |
| 触发词正则只提取特定模式 | 增加对 `# Triggers` 标题段落的提取 |
| description 只取前 200 字符 | 可按句号/换行智能截断 |
| 不解析 Markdown 结构 | 可按 `## Heading` 分段提取语义块 |

### 5.4 添加新的 API 端点

在 `server.js` 的 API routes 区块中添加。约定：
- GET 用于读取/列表
- POST 用于带请求体的查询
- 路径统一前缀 `/api/`
- 返回 JSON

### 5.5 添加新的前端 Tab

步骤：
1. 在 HTML `.tabs` 区块添加新按钮：
   ```html
   <button class="tab-btn" onclick="switchTab('newtab')">New Tab</button>
   ```
2. 添加 tab panel：
   ```html
   <div class="tab-panel" id="panel-newtab">...</div>
   ```
3. 修改 `switchTab()` 中的索引映射数组：
   ```javascript
   ['demo','conflicts','newtab'][i] === name
   ```

---

## 6. 已知技术债务

| 编号 | 问题 | 影响 | 建议修复方式 |
|------|------|------|-------------|
| TD-1 | 前端全部内联在单个 HTML 文件中 | 文件 539 行，CSS/JS 混在一起，不利于独立修改 | 拆分为 `style.css` + `app.js` + `index.html` |
| TD-2 | `gray-matter` 在依赖中但未被使用 | 浪费依赖空间，且手写解析器不够健壮 | 替换 `parseSkillFile()` 用 `gray-matter` |
| TD-3 | 冲突检测是 O(n²) | 100 个 Skill → 4950 对比较，目前性能可接受 | 如果 Skill 数量超过 500，考虑分桶优化或增量检测 |
| TD-4 | `switchTab()` 靠 index 映射 tab 名 | 添加新 tab 时容易搞错索引 | 改用 `data-tab` 属性匹配 |
| TD-5 | SKILL_DIRS 硬编码绝对路径 | 换机器需手动改 | 改为读配置文件或环境变量 |
| TD-6 | 前端 `API` 地址硬编码 `localhost:3791` | 无法部署到远程 | 改为相对路径 `/api/...` 或从 `window.location` 派生 |
| TD-7 | tokenize 不支持中文分词 | 中文触发词"升级BBU"被视为一个 token | 集成 jieba 或按字符 bigram 分词 |
| TD-8 | 无测试 | 评分算法和冲突检测没有单元测试 | 添加 Jest/Vitest 测试 |

---

## 7. 重构建议（按优先级排列）

### P0 — 必须做（影响正确性）

1. **用 gray-matter 替换手写 YAML 解析器**
   - 当前解析器无法处理嵌套 YAML、引号转义、多行字段等边界情况
   - `gray-matter` 已在 `package.json` 依赖中，直接 require 即可
   - 修改范围：`parseSkillFile()` 函数内部

2. **SKILL_DIRS 配置外部化**
   - 方案 A：从 `config.json` 读取
   - 方案 B：从环境变量 `SKILL_DIRS` 读取（JSON 字符串）
   - 方案 C：从命令行参数读取

### P1 — 应该做（改善可维护性）

3. **前端拆分为 3 个文件**
   - `index.html` — 纯结构
   - `style.css` — 样式
   - `app.js` — 逻辑
   - 好处：AI Agent 可以只读/改需要的文件，减少上下文消耗

4. **前端 API 地址改为相对路径**
   - 把 `const API = 'http://localhost:3791'` 改为 `const API = ''`
   - 所有 fetch 调用自动走当前 origin

5. **switchTab 改为 data 属性驱动**
   ```html
   <button class="tab-btn" data-tab="demo">...</button>
   ```
   ```javascript
   function switchTab(name) {
     document.querySelectorAll('.tab-btn').forEach(b => {
       b.classList.toggle('active', b.dataset.tab === name);
     });
     // ...
   }
   ```

### P2 — 可以做（提升体验）

6. **添加 Skill 详情弹窗**
   - 点击 skill card 展开完整 description + 所有 triggers + 文件路径
   - 提供"在编辑器中打开"按钮

7. **添加中文分词支持**
   - 集成 `nodejieba` 或简单的 bigram 分词
   - 改善中文触发词的匹配精度

8. **添加单元测试**
   - 测试 `scoreSkill()` 的排序正确性
   - 测试 `parseSkillFile()` 的边界情况
   - 测试 `jaccard()` 的数学正确性

---

## 8. 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| PORT | 服务器监听端口 | 3791 (硬编码，需改为 `process.env.PORT \|\| 3791`) |
| HTTP_PROXY | 代理（如需下载依赖） | — |
| HTTPS_PROXY | 代理 | — |

---

## 9. 排错指南

| 症状 | 原因 | 解决 |
|------|------|------|
| 前端显示"Server not reachable" | server.js 未启动 | `npm start` |
| 加载了 0 个 Skill | SKILL_DIRS 路径不存在 | 检查路径拼写 |
| 搜索无结果 | 查询词太短（≤1 字符被过滤） | 用更长的关键词 |
| 冲突检测为空 | threshold 太高或 Skill 太少 | 降低 threshold |
| 端口占用 | 3791 被其他进程占用 | 改 PORT 或杀掉占用进程 |
