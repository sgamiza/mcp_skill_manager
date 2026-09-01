const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Skill directories to scan ───────────────────────────────────────────────
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SKILL_DIRS_CONFIG_FILE = path.join(__dirname, 'skill-dirs.json');

function expandHome(p) {
  if (p.startsWith('~/') || p === '~') return path.join(HOME, p.slice(2));
  if (p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

function loadSkillDirs() {
  const defaults = [
    { root: path.join(HOME, '.cursor', 'skills-cursor'), label: 'cursor-builtin' },
    { root: path.join(HOME, '.cursor', 'skills'),        label: 'cursor-skills' },
    { root: path.join(HOME, '.claude', 'skills'),        label: 'claude-skills' },
    { root: path.join(HOME, 'projects'),                 label: 'local-projects', skipDirs: new Set(['.cursor', '.claude']) },
  ];
  try {
    const cfg = JSON.parse(fs.readFileSync(SKILL_DIRS_CONFIG_FILE, 'utf8'));
    if (Array.isArray(cfg.dirs) && cfg.dirs.length > 0) {
      return cfg.dirs.map(d => ({
        root: expandHome(d.root),
        label: d.label || path.basename(d.root),
        ...(d.skipDirs ? { skipDirs: new Set(d.skipDirs) } : {}),
      }));
    }
  } catch (_) {}
  return defaults;
}

const SKILL_EXTRA_FROM_ENV = process.env.SKILL_EXTRA_DIRS
  ? process.env.SKILL_EXTRA_DIRS.split(';').map(d => ({ root: d.trim(), label: path.basename(d.trim()) }))
  : [];

function getSkillDirs() {
  return [...loadSkillDirs(), ...SKILL_EXTRA_FROM_ENV];
}

const WALK_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);

// ─── MCP scan sources（可用 mcp-dirs.json 自定义/收窄）─────────────────────────
// mcp-dirs.json 让你像 skill-dirs.json 一样控制 MCP 来源：
//   · 不存在该文件 或 省略某个键  → 用下面的默认值
//   · 把某键设为 []              → 关闭该来源（例如 "scriptDirs": [] 就不扫 ~/.claude/mcp）
// 路径支持 ~。键：projectRoots / descriptorDirs / configFiles / scanDirs / scriptDirs / pluginRoots
const MCP_DIRS_CONFIG_FILE = path.join(__dirname, 'mcp-dirs.json');

function loadMcpDirs() {
  const defaults = {
    projectRoots:   [path.join(HOME, '.cursor', 'projects')],                                 // Source 1: <root>/<project>/mcps/<server>/
    descriptorDirs: [],                                                                        // Source 1b: 扁平 <dir>/<server>/ 描述符目录
    configFiles: [                                                                             // Source 2: mcp.json / .mcp.json
      { file: path.join(HOME, '.cursor', 'mcp.json'),  source: 'cursor-global' },
      { file: path.join(HOME, '.claude', '.mcp.json'), source: 'claude-global' },
    ],
    scanDirs: process.env.MCP_SCAN_DIRS                                                        // Source 3: 递归找项目级 mcp.json
      ? process.env.MCP_SCAN_DIRS.split(';').map(d => d.trim()) : [],
    scriptDirs: [{ dir: path.join(HOME, '.claude', 'mcp'), source: 'claude-mcp-scripts' }],    // Source 4: 自定义 MCP 脚本目录
    pluginRoots: [path.join(HOME, '.cursor', 'plugins', 'cache')],                             // Source 5: Cursor 插件市场 MCP
  };
  try {
    const cfg = JSON.parse(fs.readFileSync(MCP_DIRS_CONFIG_FILE, 'utf8'));
    const cfgSource = (p) => { const lp = String(p).toLowerCase(); return lp.includes('.cursor') ? 'cursor-global' : lp.includes('.claude') ? 'claude-global' : 'mcp-config'; };
    const scrSource = (p) => String(p).toLowerCase().includes('.claude') ? 'claude-mcp-scripts' : 'mcp-scripts';
    return {
      projectRoots:   Array.isArray(cfg.projectRoots)   ? cfg.projectRoots.map(expandHome)   : defaults.projectRoots,
      descriptorDirs: Array.isArray(cfg.descriptorDirs) ? cfg.descriptorDirs.map(expandHome) : defaults.descriptorDirs,
      configFiles:    Array.isArray(cfg.configFiles)    ? cfg.configFiles.map(f => ({ file: expandHome(f), source: cfgSource(f) })) : defaults.configFiles,
      scanDirs:       Array.isArray(cfg.scanDirs)       ? cfg.scanDirs.map(expandHome)       : defaults.scanDirs,
      scriptDirs:     Array.isArray(cfg.scriptDirs)     ? cfg.scriptDirs.map(d => ({ dir: expandHome(d), source: scrSource(d) })) : defaults.scriptDirs,
      pluginRoots:    Array.isArray(cfg.pluginRoots)    ? cfg.pluginRoots.map(expandHome)    : defaults.pluginRoots,
    };
  } catch (_) { return defaults; }
}
let MCP_DIRS = loadMcpDirs();   // let：POST /api/mcp-dirs 保存后，buildMcpIndex 会重新读取

// ─── Skill category inference ────────────────────────────────────────────────
const CATEGORY_PREFIX_RULES = [
  { prefix: 'nokia-',     category: 'nokia',         label: 'Nokia' },
  { prefix: 'feishu-',    category: 'feishu',         label: '飞书 Feishu' },
  { prefix: 'llm-wiki',   category: 'knowledge',      label: '知识库 Knowledge' },
  { prefix: 'playwright-', category: 'browser',       label: '浏览器 Browser' },
  { prefix: 'cursor-',    category: 'ai-agent',       label: 'AI Agent' },
  { prefix: 'grill-',     category: 'ai-agent',       label: 'AI Agent' },
  { prefix: 'create-',    category: 'cursor-builtin', label: 'Cursor 内置' },
  { prefix: 'update-',    category: 'cursor-builtin', label: 'Cursor 内置' },
];

const CATEGORY_EXACT_RULES = {
  'bbu-sw-upgrade':     'nokia',
  'bts-status':         'nokia',
  'rru-sw-upgrade':     'nokia',
  'prel3-lib-install':  'nokia',
  'robot-auto-debug':   'nokia',
  'lmi-eth-enable':     'nokia',
  'restart-amize-openclaw': 'feishu',
  'metamemory':         'knowledge',
  'metabot':            'ai-agent',
  'restart-metabot':    'ai-agent',
  'metaskill':          'dev-tools',
  'skill-hub':          'dev-tools',
  'github-safe-push':   'dev-tools',
  'daily-report':       'dev-tools',
  'build-android-apk-windows': 'dev-tools',
  'jira-query':         'dev-tools',
  'admin-run':          'system',
  'lock-screen':        'system',
  'backup-pc':          'system',
  'camera-capture':     'system',
  'monitor-camera':     'system',
  'win-short-path':     'system',
  'ssh-run':            'system',
  'browser-search':     'browser',
  'weather-compare':    'browser',
  'voice':              'media',
  'china-news-pdf':     'media',
  'resume-update':      'media',
  'science-lesson-prep':'media',
  'server-ops-wiki-first': 'system',
  'registry-proxy-setup':  'system',
  // Cursor built-in skills
  'babysit':            'cursor-builtin',
  'canvas':             'cursor-builtin',
  'loop':               'cursor-builtin',
  'shell':              'cursor-builtin',
  'sdk':                'cursor-builtin',
  'split-to-prs':       'cursor-builtin',
  'statusline':         'cursor-builtin',
  'migrate-to-skills':  'cursor-builtin',
  // Knowledge / wiki sub-skills
  'baoyu-url-to-markdown': 'knowledge',
  'youtube-transcript':    'knowledge',
  // Workflow / methodology skills
  'flows':                         'dev-tools',
  'deploy':                        'dev-tools',
  'brainstorming':                 'dev-tools',
  'dispatching-parallel-agents':   'dev-tools',
  'executing-plans':               'dev-tools',
  'finishing-a-development-branch':'dev-tools',
  'receiving-code-review':         'dev-tools',
  'requesting-code-review':        'dev-tools',
  'subagent-driven-development':   'dev-tools',
  'systematic-debugging':          'dev-tools',
  'test-driven-development':       'dev-tools',
  'using-git-worktrees':           'dev-tools',
  'using-superpowers':             'dev-tools',
  'verification-before-completion':'dev-tools',
  'writing-plans':                 'dev-tools',
  'writing-skills':                'dev-tools',
};

const CATEGORY_LABELS = {
  'nokia':          'Nokia',
  'feishu':         'Feishu',
  'knowledge':      '知识库 Knowledge',
  'dev-tools':      '开发工具 Dev Tools',
  'system':         '系统工具 System',
  'browser':        '浏览器 Browser',
  'ai-agent':       'AI Agent',
  'media':          '媒体 Media',
  'cursor-builtin': 'Cursor 内置',
  'other':          '其它 Other',
};

function inferCategory(name) {
  if (CATEGORY_EXACT_RULES[name]) return CATEGORY_EXACT_RULES[name];
  for (const rule of CATEGORY_PREFIX_RULES) {
    if (name.startsWith(rule.prefix)) return rule.category;
  }
  return 'other';
}

// ─── Parse a single SKILL.md file ────────────────────────────────────────────
function parseSkillFile(filePath, sourceLabel) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const stat = fs.statSync(filePath);
    const lines = raw.split('\n');

    let name = '';
    let description = '';
    let category = '';
    let triggers = [];
    let inFrontMatter = false;
    let frontMatterDone = false;
    let descLines = [];
    let inDesc = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0 && line.trim() === '---') { inFrontMatter = true; continue; }
      if (inFrontMatter && line.trim() === '---') { inFrontMatter = false; frontMatterDone = true; continue; }
      if (inFrontMatter) {
        if (line.startsWith('name:')) {
          name = line.replace('name:', '').trim().replace(/['"]/g, '');
        } else if (line.startsWith('category:')) {
          category = line.replace('category:', '').trim().replace(/['"]/g, '');
        } else if (line.startsWith('description:')) {
          const val = line.replace('description:', '').trim();
          if (val === '>-' || val === '>') { inDesc = true; }
          else { description = val.replace(/['"]/g, ''); }
        } else if (inDesc && (line.startsWith('  ') || line.startsWith('\t'))) {
          descLines.push(line.trim());
        } else if (inDesc && line.trim() !== '') {
          inDesc = false;
        }
      }
    }

    if (descLines.length) description = descLines.join(' ');
    if (!name) name = path.basename(path.dirname(filePath));
    if (!category) category = inferCategory(name);

    const triggerPatterns = [
      /触发[词条件：:]+([^\n]+)/gi,
      /auto-trigger[^:]*:\s*([^\n]+)/gi,
      /Use when[^:]*:\s*([^\n]+)/gi,
      /trigger[s]?[^:]*:\s*([^\n]+)/gi,
    ];
    for (const pat of triggerPatterns) {
      const matches = raw.matchAll(pat);
      for (const m of matches) {
        triggers.push(...m[1].split(/[,，、]/g).map(s => s.trim()).filter(Boolean));
      }
    }

    const content = raw.slice(0, 2000);

    return {
      id: `${sourceLabel}/${name}`,
      name,
      category,
      categoryLabel: CATEGORY_LABELS[category] || category,
      description: description.slice(0, 200),
      triggers: triggers.slice(0, 20),
      source: sourceLabel,
      filePath,
      mtime: stat.mtimeMs,
      mtimeISO: stat.mtime.toISOString(),
      size: stat.size,
      content,
    };
  } catch (e) {
    return null;
  }
}

// ─── Build the skill index ────────────────────────────────────────────────────
function buildIndex() {
  const skills = [];
  for (const { root, label, skipDirs } of getSkillDirs()) {
    if (!fs.existsSync(root)) continue;
    const entries = walkDir(root, [], skipDirs);
    for (const fp of entries) {
      if (path.basename(fp).toLowerCase() === 'skill.md') {
        const skill = parseSkillFile(fp, label);
        if (skill) skills.push(skill);
      }
    }
  }
  return skills;
}

function walkDir(dir, files = [], extraSkipDirs = null) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (WALK_SKIP_DIRS.has(e.name)) continue;
      if (extraSkipDirs && extraSkipDirs.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkDir(full, files, extraSkipDirs);
      else files.push(full);
    }
  } catch (_) {}
  return files;
}

// ─── Static MCP tool extraction (no need to run server) ──────────────────────
// Given an mcp.json server config, try to locate the actual script file
// (e.g. `python C:\path\to\server.py`, `node C:\path\to\index.js`, `uvx pkg`)
// and statically extract tool registrations from it.
function resolveScriptFromConfig(config, configPath) {
  if (!config || typeof config !== 'object') return null;
  const cmd = (config.command || '').toLowerCase();
  const args = (config.args || []).map(String);
  if (!args.length) return null;

  const cfgDir = configPath ? path.dirname(configPath) : process.cwd();

  // Find an arg that looks like a script path (.py / .js / .ts / .mjs / .cjs)
  for (const a of args) {
    if (/^[-/]/.test(a) && !/[/\\]/.test(a)) continue; // skip plain flags like "-m"
    const ext = path.extname(a).toLowerCase();
    if (!['.py', '.js', '.ts', '.mjs', '.cjs'].includes(ext)) continue;

    const candidates = [
      a,
      path.resolve(cfgDir, a),
      path.resolve(process.cwd(), a),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      } catch (_) {}
    }
  }

  // `python -m package.module` — locate `package/module.py` near config
  if (cmd === 'python' || cmd === 'python3' || cmd === 'py') {
    const mIdx = args.findIndex(a => a === '-m');
    if (mIdx >= 0 && args[mIdx + 1]) {
      const mod = args[mIdx + 1].replace(/\./g, path.sep) + '.py';
      const trial = path.resolve(cfgDir, mod);
      if (fs.existsSync(trial)) return trial;
    }
  }
  return null;
}

function extractToolsFromScript(scriptPath) {
  let raw;
  try { raw = fs.readFileSync(scriptPath, 'utf8'); } catch (_) { return []; }
  if (!raw) return [];

  const tools = new Map(); // name -> { name, description, line, _scriptFile }
  const lines = raw.split('\n');

  // ── Python patterns ──
  // 1) Decorator-defined: `@mcp.tool()` or `@server.tool(name="...")` then `def foo(`
  // 2) Programmatic:    `server.add_tool("foo", ...)` / `mcp.tool(name="foo")(fn)`
  const pyDecoratorRe = /^\s*@(?:[a-zA-Z_][\w]*\.)?tool\s*\(([^)]*)\)/;
  const pyDefRe = /^\s*(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\(/;
  const pyDocstringRe = /^\s*("""|''')([\s\S]*?)(\1)/;

  for (let i = 0; i < lines.length; i++) {
    const mDec = lines[i].match(pyDecoratorRe);
    if (!mDec) continue;
    // Skip any additional decorators
    let j = i + 1;
    while (j < lines.length && /^\s*@/.test(lines[j])) j++;
    const mDef = lines[j] && lines[j].match(pyDefRe);
    if (!mDef) continue;

    // Tool name: prefer name="x" inside decorator, else function name
    let toolName = mDef[1];
    const nameMatch = mDec[1].match(/name\s*=\s*['"]([^'"]+)['"]/);
    if (nameMatch) toolName = nameMatch[1];

    // Find end of (possibly multi-line) function signature via paren counting.
    // Signature ends on the line that closes the def-paren AND ends with `:`.
    let sigEnd = j;
    let depth = 0;
    let started = false;
    for (let p = j; p < lines.length && p - j < 80; p++) {
      const code = lines[p].split('#')[0];
      for (const ch of code) {
        if (ch === '(') { depth++; started = true; }
        else if (ch === ')') depth--;
      }
      if (started && depth === 0 && /:\s*$/.test(code.trimEnd())) {
        sigEnd = p;
        break;
      }
    }

    // Description: docstring starting on first non-empty line after signature
    let description = '';
    let k = sigEnd + 1;
    while (k < lines.length && lines[k].trim() === '') k++;
    if (k < lines.length) {
      const rest = lines.slice(k, Math.min(k + 60, lines.length)).join('\n');
      const m = rest.match(pyDocstringRe);
      if (m) {
        const body = m[2].trim();
        // Take first non-empty meaningful line(s) up to a blank line
        const firstChunk = body.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
        description = firstChunk.slice(0, 200);
      }
    }
    // Fallback: description="..." inside decorator
    if (!description) {
      const dm = mDec[1].match(/description\s*=\s*['"]([^'"]+)['"]/);
      if (dm) description = dm[1].slice(0, 200);
    }

    tools.set(toolName, { name: toolName, description, line: j + 1, _scriptFile: scriptPath });
  }

  // Python programmatic registrations: server.add_tool("name", ...)
  const pyAddToolRe = /\.add_tool\s*\(\s*['"]([a-zA-Z_][\w-]*)['"]/g;
  let mm;
  while ((mm = pyAddToolRe.exec(raw)) !== null) {
    if (!tools.has(mm[1])) tools.set(mm[1], { name: mm[1], description: '', _scriptFile: scriptPath });
  }

  // ── JS / TS patterns ──
  // 1) server.tool("name", "desc", schema, async (args) => {...})
  // 2) server.registerTool("name", {description: "..."} , ...)
  // 3) tools: { name: { description: "...", ... } }  (object map)
  const jsToolCallRe = /(?:^|[^a-zA-Z_])(?:server|mcp|app|tools?)\.(?:register)?tool\s*\(\s*['"`]([a-zA-Z_][\w-]*)['"`]\s*(?:,\s*(?:\{[^}]*description\s*:\s*['"`]([^'"`]+)['"`][^}]*\}|['"`]([^'"`]+)['"`]))?/g;
  while ((mm = jsToolCallRe.exec(raw)) !== null) {
    const name = mm[1];
    const desc = (mm[2] || mm[3] || '').slice(0, 200);
    if (!tools.has(name)) tools.set(name, { name, description: desc, _scriptFile: scriptPath });
    else if (desc && !tools.get(name).description) tools.get(name).description = desc;
  }

  return [...tools.values()];
}

function extractToolsFromConfig(config, configPath) {
  try {
    const script = resolveScriptFromConfig(config, configPath);
    if (!script) return [];
    return extractToolsFromScript(script);
  } catch (_) { return []; }
}

// ─── Build MCP index ──────────────────────────────────────────────────────────
function buildMcpIndex() {
  MCP_DIRS = loadMcpDirs();   // 每次重建都重新读 mcp-dirs.json（UI 保存后无需重启即可生效）
  const servers = new Map();

  function addServer(id, data) {
    if (servers.has(id)) {
      const existing = servers.get(id);
      if (data.tools.length > existing.tools.length) servers.set(id, data);
      return;
    }
    servers.set(id, data);
  }

  function parseToolDescriptors(toolsDir) {
    const tools = [];
    if (!fs.existsSync(toolsDir)) return tools;
    try {
      const toolFiles = fs.readdirSync(toolsDir).filter(f => f.endsWith('.json'));
      for (const tf of toolFiles) {
        try {
          const tool = JSON.parse(fs.readFileSync(path.join(toolsDir, tf), 'utf8'));
          const params = [];
          if (tool.arguments?.properties) {
            const required = new Set(tool.arguments.required || []);
            for (const [pName, pDef] of Object.entries(tool.arguments.properties)) {
              params.push({
                name: pName,
                type: pDef.type || 'any',
                required: required.has(pName),
                description: (pDef.description || '').slice(0, 120),
              });
            }
          }
          tools.push({
            name: tool.name || tf.replace('.json', ''),
            description: (tool.description || '').slice(0, 300),
            params,
            filePath: path.join(toolsDir, tf),
          });
        } catch (_) {}
      }
    } catch (_) {}
    return tools;
  }

  function parseResources(resourcesDir) {
    const resources = [];
    if (!fs.existsSync(resourcesDir)) return resources;
    try {
      const resFiles = fs.readdirSync(resourcesDir).filter(f => f.endsWith('.json'));
      for (const rf of resFiles) {
        try {
          const res = JSON.parse(fs.readFileSync(path.join(resourcesDir, rf), 'utf8'));
          resources.push({
            name: res.name || rf.replace('.json', ''),
            description: (res.description || '').slice(0, 200),
            uri: res.uri || '',
          });
        } catch (_) {}
      }
    } catch (_) {}
    return resources;
  }

  // ── Source 1: MCP descriptor dirs (<server>/SERVER_METADATA.json + tools/ + resources/) ──
  function scanMcpsDir(mcpsDir, source) {
    if (!fs.existsSync(mcpsDir)) return;
    try {
      const serverDirs = fs.readdirSync(mcpsDir, { withFileTypes: true });
      for (const srv of serverDirs) {
        if (!srv.isDirectory()) continue;
        const serverPath = path.join(mcpsDir, srv.name);
        let meta = { serverIdentifier: srv.name, serverName: srv.name };
        try { meta = JSON.parse(fs.readFileSync(path.join(serverPath, 'SERVER_METADATA.json'), 'utf8')); } catch (_) {}
        const tools = parseToolDescriptors(path.join(serverPath, 'tools'));
        const resources = parseResources(path.join(serverPath, 'resources'));
        addServer(srv.name, {
          id: srv.name,
          name: meta.serverName || srv.name,
          identifier: meta.serverIdentifier || srv.name,
          source,
          tools, resources,
          toolCount: tools.length,
          resourceCount: resources.length,
          configFile: path.join(serverPath, 'SERVER_METADATA.json'),
        });
      }
    } catch (_) {}
  }

  // Source 1a: Cursor project roots — <root>/<project>/mcps/<server>/
  for (const projectsRoot of MCP_DIRS.projectRoots) {
    if (!fs.existsSync(projectsRoot)) continue;
    try {
      const projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
      for (const proj of projectDirs) {
        if (!proj.isDirectory()) continue;
        scanMcpsDir(path.join(projectsRoot, proj.name, 'mcps'), 'cursor-project');
      }
    } catch (_) {}
  }

  // Source 1b: 直接的 mcps 目录（扁平 <dir>/<server>/）
  for (const descDir of MCP_DIRS.descriptorDirs) {
    scanMcpsDir(descDir, 'mcp-descriptor');
  }

  // ── Source 2: mcp.json / .mcp.json config files ──
  for (const { file, source } of MCP_DIRS.configFiles) {
    parseMcpConfigFile(file, source);
  }

  // ── Source 3: Scan dirs for project-level mcp.json / .mcp.json ──
  for (const scanDir of MCP_DIRS.scanDirs) {
    if (!fs.existsSync(scanDir)) continue;
    const configFiles = [];
    findMcpConfigs(scanDir, configFiles, 0, 5);
    for (const cf of configFiles) {
      parseMcpConfigFile(cf, 'project-config');
    }
  }

  function findMcpConfigs(dir, results, depth, maxDepth) {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (WALK_SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          findMcpConfigs(full, results, depth + 1, maxDepth);
        } else if (e.name === 'mcp.json' || e.name === '.mcp.json') {
          results.push(full);
        }
      }
    } catch (_) {}
  }

  function parseMcpConfigFile(filePath, source) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const srvMap = data.mcpServers || data;
      for (const [name, config] of Object.entries(srvMap)) {
        if (typeof config !== 'object' || config === null) continue;
        const transport = config.type || config.transport || (config.url ? 'http' : 'stdio');
        const cmd = config.command || '';
        const args = (config.args || []).join(' ');
        const url = config.url || '';
        const desc = transport === 'http'
          ? `HTTP MCP: ${url}`
          : `${cmd} ${args}`.trim();

        // Try to extract tools from script file via static analysis
        const staticTools = extractToolsFromConfig(config, filePath);

        addServer(name, {
          id: name,
          name,
          identifier: name,
          source,
          transport,
          command: cmd,
          url,
          enabled: config.enabled !== false && config.disabled !== true,
          tools: staticTools,
          resources: [],
          toolCount: staticTools.length,
          toolDiscoveryMethod: staticTools.length ? 'static-analysis' : 'none',
          scriptFile: staticTools.length ? staticTools[0]._scriptFile : undefined,
          resourceCount: 0,
          configFile: filePath,
          description: desc.slice(0, 200),
        });
      }
    } catch (_) {}
  }

  // ── Source 4: Custom MCP scripts ──
  for (const { dir, source } of MCP_DIRS.scriptDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.py') || f.endsWith('.js') || f.endsWith('.ts'));
      for (const f of files) {
        const scriptName = f.replace(/\.(py|js|ts)$/, '');
        if (!servers.has(scriptName)) {
          const fullPath = path.join(dir, f);
          let desc = '';
          try {
            const content = fs.readFileSync(fullPath, 'utf8').slice(0, 500);
            const docMatch = content.match(/(?:"""([^]*?)"""|'''([^]*?)'''|\/\*\*([^]*?)\*\/)/);
            if (docMatch) desc = (docMatch[1] || docMatch[2] || docMatch[3] || '').trim().slice(0, 200);
          } catch (_) {}
          const staticTools = extractToolsFromScript(fullPath);
          addServer(scriptName, {
            id: scriptName,
            name: scriptName,
            identifier: scriptName,
            source,
            transport: 'stdio',
            command: f.endsWith('.py') ? 'python' : 'node',
            tools: staticTools,
            resources: [],
            toolCount: staticTools.length,
            toolDiscoveryMethod: staticTools.length ? 'static-analysis' : 'none',
            scriptFile: fullPath,
            configFile: fullPath,
            description: desc || `Custom MCP script: ${f}`,
          });
        }
      }
    } catch (_) {}
  }

  // ── Source 5: Cursor plugins ──
  for (const pluginRoot of MCP_DIRS.pluginRoots) {
    if (!fs.existsSync(pluginRoot)) continue;
    try {
      const vendors = fs.readdirSync(pluginRoot, { withFileTypes: true });
      for (const vendor of vendors) {
        if (!vendor.isDirectory()) continue;
        const vendorDir = path.join(pluginRoot, vendor.name);
        const plugins = fs.readdirSync(vendorDir, { withFileTypes: true });
        for (const plugin of plugins) {
          if (!plugin.isDirectory()) continue;
          const pluginDir = path.join(vendorDir, plugin.name);
          const mcpFiles = findMcpJsonInDir(pluginDir, 2);
          for (const mcpFile of mcpFiles) {
            try {
              const data = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
              const srvMap = data.mcpServers || data;
              for (const [name, config] of Object.entries(srvMap)) {
                if (typeof config !== 'object' || config === null) continue;
                const transport = config.type || config.transport || (config.url ? 'http' : 'stdio');
                const staticTools = extractToolsFromConfig(config, mcpFile);
                addServer(`plugin-${vendor.name}-${name}`, {
                  id: `plugin-${vendor.name}-${name}`,
                  name: `${name} (${vendor.name})`,
                  identifier: name,
                  source: 'cursor-plugin',
                  transport,
                  url: config.url || '',
                  command: config.command || '',
                  tools: staticTools,
                  resources: [],
                  toolCount: staticTools.length,
                  toolDiscoveryMethod: staticTools.length ? 'static-analysis' : 'none',
                  scriptFile: staticTools.length ? staticTools[0]._scriptFile : undefined,
                  resourceCount: 0,
                  configFile: mcpFile,
                  description: config.url ? `Plugin: ${config.url}` : `Plugin: ${config.command || ''} ${(config.args || []).join(' ')}`.trim(),
                });
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  function findMcpJsonInDir(dir, maxDepth, depth = 0) {
    const results = [];
    if (depth > maxDepth) return results;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isFile() && e.name === 'mcp.json') results.push(full);
        else if (e.isDirectory()) results.push(...findMcpJsonInDir(full, maxDepth, depth + 1));
      }
    } catch (_) {}
    return results;
  }

  return [...servers.values()];
}

// ─── Scoring algorithm ───────────────────────────────────────────────────────
function scoreSkill(skill, query) {
  const qLower = query.toLowerCase();
  const qTokens = tokenize(qLower);
  if (!qTokens.length) return 0;

  let score = 0;

  const nameLower = skill.name.toLowerCase();
  for (const tok of qTokens) {
    if (nameLower.includes(tok)) score += 10;
    if (nameLower === tok) score += 5;
  }

  const descLower = skill.description.toLowerCase();
  for (const tok of qTokens) {
    score += countOccurrences(descLower, tok) * 4;
  }

  const triggerText = skill.triggers.join(' ').toLowerCase();
  for (const tok of qTokens) {
    if (triggerText.includes(tok)) score += 6;
  }

  const contentLower = skill.content.toLowerCase();
  for (const tok of qTokens) {
    score += Math.min(countOccurrences(contentLower, tok), 5) * 1.5;
  }

  if (descLower.includes(qLower) || triggerText.includes(qLower)) score += 15;
  if (contentLower.includes(qLower)) score += 8;

  return Math.round(score * 10) / 10;
}

function scoreMcpTool(tool, serverName, query) {
  const qLower = query.toLowerCase();
  const qTokens = tokenize(qLower);
  if (!qTokens.length) return 0;

  let score = 0;
  const nameLower = tool.name.toLowerCase();
  const descLower = tool.description.toLowerCase();
  const srvLower = serverName.toLowerCase();

  for (const tok of qTokens) {
    if (nameLower.includes(tok)) score += 12;
    if (nameLower === tok) score += 5;
    if (srvLower.includes(tok)) score += 6;
    score += countOccurrences(descLower, tok) * 3;
  }

  if (descLower.includes(qLower)) score += 15;

  return Math.round(score * 10) / 10;
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const CJK_STOP = new Set('的了吗呢吧啊呀哦哈嗯一下不也都是在有就把被给让'.split(''));

function tokenize(str) {
  const tokens = new Set();
  const parts = str.split(/[\s\-_.,;:!?/\\()\[\]{}'"，。、；：！？]+/).filter(Boolean);

  for (const part of parts) {
    const segments = part.match(/[\u4e00-\u9fff\u3400-\u4dbf]+|[a-zA-Z0-9]+/g);
    if (!segments) continue;

    for (const seg of segments) {
      if (CJK_RE.test(seg)) {
        for (let i = 0; i < seg.length; i++) {
          if (!CJK_STOP.has(seg[i])) tokens.add(seg[i]);
          if (i + 1 < seg.length) tokens.add(seg.slice(i, i + 2));
        }
        if (seg.length > 2) tokens.add(seg);
      } else if (seg.length > 1) {
        tokens.add(seg);
      }
    }
  }
  return [...tokens];
}

function scoreMcpServer(srv, query) {
  const qLower = query.toLowerCase();
  const qTokens = tokenize(qLower);
  if (!qTokens.length) return 0;

  let score = 0;
  const nameLower = srv.name.toLowerCase();
  const idLower = srv.id.toLowerCase();
  const descLower = (srv.description || '').toLowerCase();

  for (const tok of qTokens) {
    if (nameLower.includes(tok)) score += 12;
    if (nameLower === tok) score += 5;
    if (idLower !== nameLower && idLower.includes(tok)) score += 8;
    score += countOccurrences(descLower, tok) * 3;
  }

  if (descLower.includes(qLower)) score += 15;

  return Math.round(score * 10) / 10;
}

function countOccurrences(str, sub) {
  let count = 0, pos = 0;
  while ((pos = str.indexOf(sub, pos)) !== -1) { count++; pos += sub.length; }
  return count;
}

// ─── Cache ───────────────────────────────────────────────────────────────────
let cachedIndex = null;
let cacheTime = 0;
let cachedMcp = null;
let mcpCacheTime = 0;
const CACHE_TTL = 30000;

function getIndex() {
  const now = Date.now();
  if (!cachedIndex || now - cacheTime > CACHE_TTL) {
    cachedIndex = buildIndex();
    cacheTime = now;
  }
  return cachedIndex;
}

function getMcpIndex() {
  const now = Date.now();
  if (!cachedMcp || now - mcpCacheTime > CACHE_TTL) {
    cachedMcp = buildMcpIndex();
    mcpCacheTime = now;
  }
  return cachedMcp;
}

// ─── Skill API routes ────────────────────────────────────────────────────────

app.get('/api/skills', (req, res) => {
  const index = getIndex();
  res.json(index.map(s => ({ ...s, content: undefined })));
});

app.get('/api/skill-categories', (req, res) => {
  const index = getIndex();
  const catMap = {};
  for (const s of index) {
    const cat = s.category || 'other';
    if (!catMap[cat]) catMap[cat] = { id: cat, label: s.categoryLabel || CATEGORY_LABELS[cat] || cat, count: 0, skills: [] };
    catMap[cat].count++;
    catMap[cat].skills.push({ id: s.id, name: s.name, source: s.source, description: s.description });
  }
  const order = ['nokia', 'feishu', 'knowledge', 'dev-tools', 'system', 'browser', 'ai-agent', 'media', 'cursor-builtin', 'other'];
  const sorted = order.filter(k => catMap[k]).map(k => catMap[k]);
  for (const k of Object.keys(catMap)) { if (!order.includes(k)) sorted.push(catMap[k]); }
  res.json({ total: index.length, categories: sorted });
});

// ─── Skill-dirs config CRUD ───────────────────────────────────────────────────
app.get('/api/skill-dirs', (req, res) => {
  try {
    const raw = fs.readFileSync(SKILL_DIRS_CONFIG_FILE, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/skill-dirs', (req, res) => {
  try {
    const { dirs } = req.body;
    if (!Array.isArray(dirs)) return res.status(400).json({ error: 'dirs must be an array' });
    const current = JSON.parse(fs.readFileSync(SKILL_DIRS_CONFIG_FILE, 'utf8'));
    const updated = { ...current, dirs };
    fs.writeFileSync(SKILL_DIRS_CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');
    cachedIndex = null; cacheTime = 0;
    res.json({ ok: true, count: dirs.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MCP-dirs config CRUD ─────────────────────────────────────────────────────
const MCP_DIRS_KEYS = ['projectRoots', 'descriptorDirs', 'configFiles', 'scanDirs', 'scriptDirs', 'pluginRoots'];
const MCP_DIRS_DEFAULT_STR = {
  projectRoots:   ['~/.cursor/projects'],
  descriptorDirs: [],
  configFiles:    ['~/.cursor/mcp.json', '~/.claude/.mcp.json'],
  scanDirs:       [],
  scriptDirs:     ['~/.claude/mcp'],
  pluginRoots:    ['~/.cursor/plugins/cache'],
};
const MCP_DIRS_COMMENT = '自定义 MCP 扫描来源（类似 skill-dirs.json，可在网页 UI 编辑）。删掉本文件=用内置默认；把某键设为 [] = 关闭该来源（例如 "scriptDirs": [] 就不再扫 ~/.claude/mcp）。路径支持 ~。键：projectRoots（<root>/<proj>/mcps/<server>/）· descriptorDirs（扁平 <dir>/<server>/）· configFiles（mcp.json / .mcp.json）· scanDirs（递归找项目级 mcp.json）· scriptDirs（自定义 MCP 脚本目录）· pluginRoots（Cursor 插件缓存）。';

app.get('/api/mcp-dirs', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(MCP_DIRS_CONFIG_FILE, 'utf8'));
    const out = {};
    for (const k of MCP_DIRS_KEYS) out[k] = Array.isArray(cfg[k]) ? cfg[k] : MCP_DIRS_DEFAULT_STR[k];
    res.json(out);
  } catch (_) {
    res.json({ ...MCP_DIRS_DEFAULT_STR });
  }
});

app.post('/api/mcp-dirs', (req, res) => {
  try {
    const body = req.body || {};
    const out = { _comment: MCP_DIRS_COMMENT };
    for (const k of MCP_DIRS_KEYS) {
      if (body[k] !== undefined && !Array.isArray(body[k])) {
        return res.status(400).json({ error: `${k} must be an array` });
      }
      const arr = Array.isArray(body[k]) ? body[k] : MCP_DIRS_DEFAULT_STR[k];
      out[k] = arr.map(s => String(s).trim()).filter(Boolean);
    }
    fs.writeFileSync(MCP_DIRS_CONFIG_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
    cachedMcp = null; mcpCacheTime = 0;   // 下次 getMcpIndex() 会重读 mcp-dirs.json
    const counts = {}; for (const k of MCP_DIRS_KEYS) counts[k] = out[k].length;
    res.json({ ok: true, counts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/search', (req, res) => {
  const { query } = req.body;
  if (!query || !query.trim()) return res.json([]);

  const index = getIndex();
  const results = index
    .map(skill => ({ ...skill, content: undefined, score: scoreSkill(skill, query) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 18);

  res.json(results);
});

app.get('/api/stats', (req, res) => {
  const index = getIndex();
  const bySource = {};
  const byCategory = {};
  for (const s of index) {
    bySource[s.source] = (bySource[s.source] || 0) + 1;
    byCategory[s.category || 'other'] = (byCategory[s.category || 'other'] || 0) + 1;
  }
  res.json({ total: index.length, bySource, byCategory });
});

// ─── Conflict detection ───────────────────────────────────────────────────────

function skillKeywordSet(skill) {
  const words = new Set();
  for (const t of skill.triggers) {
    tokenize(t.toLowerCase()).forEach(w => words.add(w));
  }
  tokenize(skill.description.toLowerCase()).forEach(w => words.add(w));
  return words;
}

function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

function sharedTriggers(a, b) {
  const ta = new Set(a.triggers.map(t => t.toLowerCase().trim()));
  const tb = new Set(b.triggers.map(t => t.toLowerCase().trim()));
  const shared = [];
  for (const t of ta) {
    for (const bt of tb) {
      if (t === bt || t.includes(bt) || bt.includes(t)) {
        shared.push(t.length <= bt.length ? t : bt);
        break;
      }
    }
  }
  return [...new Set(shared)].slice(0, 8);
}

function suggestFix(a, b, sim) {
  const deprecated = ['robot-auto-debug', 'bts-status'];
  const aDeprecated = deprecated.some(d => a.name.includes(d));
  const bDeprecated = deprecated.some(d => b.name.includes(d));
  const aIsOlder = (a.source === 'claude-skills' && b.source !== 'claude-skills');
  const bIsOlder = (b.source === 'claude-skills' && a.source !== 'claude-skills');

  if (aDeprecated) return `将 "${a.name}" 的 description 标注"已整合入 ${b.name}，仅作向后兼容"`;
  if (bDeprecated) return `将 "${b.name}" 的 description 标注"已整合入 ${a.name}，仅作向后兼容"`;
  if (aIsOlder)    return `"${a.name}" 为旧版，考虑在 description 中声明已被 "${b.name}" 取代`;
  if (bIsOlder)    return `"${b.name}" 为旧版，考虑在 description 中声明已被 "${a.name}" 取代`;
  if (sim > 0.5)   return `两者高度重叠，建议合并或在 description 中用"不包括"互相排除`;
  return `在各自 description 中用"不包括：<对方场景>"明确边界`;
}

function skillRef(s) {
  return {
    id: s.id,
    name: s.name,
    source: s.source,
    category: s.category,
    categoryLabel: s.categoryLabel,
    filePath: s.filePath,
    mtime: s.mtime,
    mtimeISO: s.mtimeISO,
    size: s.size,
  };
}

app.delete('/api/skill', (req, res) => {
  const { id, confirm } = req.query;
  if (!id) return res.status(400).json({ error: 'missing id' });
  if (confirm !== 'yes') return res.status(400).json({ error: 'confirmation required: pass confirm=yes' });

  const index = getIndex();
  const skill = index.find(s => s.id === id);
  if (!skill) return res.status(404).json({ error: 'skill not found' });

  const filePath = skill.filePath;
  const fileName = path.basename(filePath).toLowerCase();
  if (fileName !== 'skill.md' && fileName !== 'agents.md' && fileName !== 'rule.md') {
    return res.status(400).json({ error: `refuse to delete non-skill file: ${fileName}` });
  }

  try {
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'file already missing on disk' });
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'path is not a regular file' });
    }

    fs.unlinkSync(filePath);

    let removedDir = null;
    try {
      const dir = path.dirname(filePath);
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
        removedDir = dir;
      }
    } catch (_) { /* ignore */ }

    cachedIndex = null;
    cacheTime = 0;

    res.json({ ok: true, deletedFile: filePath, removedEmptyDir: removedDir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/skill/content', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'missing id' });
  const index = getIndex();
  const skill = index.find(s => s.id === id);
  if (!skill) return res.status(404).json({ error: 'skill not found' });
  try {
    const raw = fs.readFileSync(skill.filePath, 'utf8');
    res.json({
      id: skill.id,
      name: skill.name,
      source: skill.source,
      filePath: skill.filePath,
      mtime: skill.mtime,
      mtimeISO: skill.mtimeISO,
      size: skill.size,
      content: raw,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open a skill's SKILL.md file in the OS default editor / app.
app.post('/api/skill/open', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing id' });
  const index = getIndex();
  const skill = index.find(s => s.id === id);
  if (!skill) return res.status(404).json({ error: 'skill not found' });
  if (!fs.existsSync(skill.filePath)) return res.status(404).json({ error: 'file not found on disk' });
  try {
    const fp = skill.filePath;
    let child;
    if (process.platform === 'win32') {
      // `start` is a cmd builtin; the empty "" is the window title placeholder.
      child = spawn('cmd', ['/c', 'start', '', fp], { detached: true, stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [fp], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [fp], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {}); // swallow spawn errors; response already sent
    child.unref();
    res.json({ ok: true, filePath: fp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/conflicts', (req, res) => {
  const index = getIndex();
  const threshold = parseFloat(req.query.threshold || '0.15');
  const conflicts = [];

  const kwSets = index.map(s => skillKeywordSet(s));

  for (let i = 0; i < index.length; i++) {
    for (let j = i + 1; j < index.length; j++) {
      const sim = jaccard(kwSets[i], kwSets[j]);
      if (sim >= threshold) {
        const shared = sharedTriggers(index[i], index[j]);
        conflicts.push({
          skillA: skillRef(index[i]),
          skillB: skillRef(index[j]),
          newerSide: index[i].mtime >= index[j].mtime ? 'A' : 'B',
          similarity: Math.round(sim * 1000) / 1000,
          sharedTriggers: shared,
          severity: sim >= 0.5 ? 'high' : sim >= 0.3 ? 'medium' : 'low',
          fix: suggestFix(index[i], index[j], sim),
        });
      }
    }
  }

  conflicts.sort((a, b) => b.similarity - a.similarity);
  res.json(conflicts);
});

app.get('/api/conflicts/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const index = getIndex();
  const threshold = parseFloat(req.query.threshold || '0.15');
  const n = index.length;
  const totalPairs = n * (n - 1) / 2;
  const conflicts = [];

  res.write(`data: ${JSON.stringify({ type: 'start', total: n, totalPairs })}\n\n`);

  const kwSets = index.map(s => skillKeywordSet(s));
  res.write(`data: ${JSON.stringify({ type: 'indexed', total: n })}\n\n`);

  let checked = 0;
  let lastReport = 0;
  const REPORT_INTERVAL = Math.max(1, Math.floor(totalPairs / 50));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = jaccard(kwSets[i], kwSets[j]);
      checked++;
      if (sim >= threshold) {
        const shared = sharedTriggers(index[i], index[j]);
        conflicts.push({
          skillA: skillRef(index[i]),
          skillB: skillRef(index[j]),
          newerSide: index[i].mtime >= index[j].mtime ? 'A' : 'B',
          similarity: Math.round(sim * 1000) / 1000,
          sharedTriggers: shared,
          severity: sim >= 0.5 ? 'high' : sim >= 0.3 ? 'medium' : 'low',
          fix: suggestFix(index[i], index[j], sim),
        });
      }
      if (checked - lastReport >= REPORT_INTERVAL) {
        lastReport = checked;
        res.write(`data: ${JSON.stringify({ type: 'progress', checked, totalPairs, found: conflicts.length, pct: Math.round(checked / totalPairs * 100) })}\n\n`);
      }
    }
  }

  conflicts.sort((a, b) => b.similarity - a.similarity);
  res.write(`data: ${JSON.stringify({ type: 'done', conflicts })}\n\n`);
  res.end();
});

// ─── MCP API routes ──────────────────────────────────────────────────────────

app.get('/api/mcp/servers', (req, res) => {
  const servers = getMcpIndex();
  res.json(servers.map(s => ({ ...s, tools: undefined, resources: undefined })));
});

app.get('/api/mcp/server/:id', (req, res) => {
  const servers = getMcpIndex();
  const server = servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'not found' });
  res.json(server);
});

app.get('/api/mcp/server', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'missing id query param' });
  const servers = getMcpIndex();
  const server = servers.find(s => s.id === id);
  if (!server) return res.status(404).json({ error: 'not found' });
  res.json(server);
});

app.get('/api/mcp/config', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'missing id' });
  const servers = getMcpIndex();
  const server = servers.find(s => s.id === id);
  if (!server) return res.status(404).json({ error: 'not found' });
  if (!server.configFile || !fs.existsSync(server.configFile)) {
    return res.json({
      id: server.id,
      name: server.name,
      configFile: server.configFile || null,
      exists: false,
      content: null,
      summary: buildConfigSummary(server),
    });
  }
  try {
    const raw = fs.readFileSync(server.configFile, 'utf8');
    const stat = fs.statSync(server.configFile);
    res.json({
      id: server.id,
      name: server.name,
      configFile: server.configFile,
      exists: true,
      content: raw,
      size: stat.size,
      mtimeISO: stat.mtime.toISOString(),
      summary: buildConfigSummary(server),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildConfigSummary(s) {
  const lines = [];
  lines.push(`# ${s.name}`);
  lines.push(`Source: ${s.source}`);
  if (s.transport) lines.push(`Transport: ${s.transport}`);
  if (s.command) lines.push(`Command: ${s.command}`);
  if (s.url) lines.push(`URL: ${s.url}`);
  if (s.enabled === false) lines.push(`Enabled: false`);
  lines.push(`Tools: ${s.toolCount} | Resources: ${s.resourceCount}`);
  if (s.configFile) lines.push(`ConfigFile: ${s.configFile}`);
  return lines.join('\n');
}

// ─── Built-in MCP probe (no Inspector needed) ───────────────────────────────
// Spawns a stdio MCP server, sends `initialize` + `tools/list` JSON-RPC
// messages, parses the response, and returns the tool list. Bypasses Inspector
// entirely (which has bugs with Windows backslash paths and concurrent SSE).
async function probeMcpServer(srv, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const cfg = readMcpJsonForServer(srv) || {};
  const command = cfg.command || srv.command;
  const cmdArgs = (cfg.args || []).map(String);
  const env = cfg.env || {};
  const url = cfg.url || srv.url;

  if (url) {
    return { ok: false, error: 'HTTP/SSE MCP probe not implemented yet; only stdio supported. URL: ' + url };
  }
  if (!command) {
    return { ok: false, error: 'no command found in mcp.json' };
  }

  return new Promise((resolve) => {
    const logs = [];
    const log = (s) => { logs.push(s); if (logs.length > 200) logs.splice(0, logs.length - 200); };
    let child;
    try {
      child = spawn(command, cmdArgs, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
    } catch (e) {
      return resolve({ ok: false, error: `spawn failed: ${e.message}`, command, args: cmdArgs });
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let done = false;
    const pending = new Map(); // id -> { resolve }
    let serverInfo = null;
    let tools = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({
        ...result,
        command,
        args: cmdArgs,
        stderr: stderrBuf.slice(-2000),
        serverInfo,
      });
    };

    const timer = setTimeout(() => finish({ ok: false, error: 'probe timeout', logs }), timeoutMs);

    const send = (msg) => {
      try {
        child.stdin.write(JSON.stringify(msg) + '\n');
        log(`> ${JSON.stringify(msg)}`);
      } catch (e) {
        finish({ ok: false, error: `stdin write failed: ${e.message}`, logs });
      }
    };

    const handle = (msg) => {
      log(`< ${JSON.stringify(msg).slice(0, 200)}`);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r } = pending.get(msg.id);
        pending.delete(msg.id);
        r(msg);
      }
    };

    const request = (method, params) => {
      const id = Math.floor(Math.random() * 1e9);
      return new Promise((r) => {
        pending.set(id, { resolve: r });
        send({ jsonrpc: '2.0', id, method, params });
      });
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      // Parse line-delimited JSON-RPC
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch (_) { /* non-JSON output */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });
    child.on('error', (e) => finish({ ok: false, error: `process error: ${e.message}`, logs }));
    child.on('exit', (code, signal) => {
      if (!done) {
        finish({
          ok: false,
          error: `process exited (code=${code} signal=${signal}) before completing handshake`,
          exitCode: code, exitSignal: signal, logs,
        });
      }
    });

    // ── MCP handshake ──
    (async () => {
      try {
        const initResp = await Promise.race([
          request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'skill-selector-probe', version: '1.0.0' },
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('initialize timeout')), timeoutMs - 1000)),
        ]);
        if (initResp.error) return finish({ ok: false, error: `initialize error: ${JSON.stringify(initResp.error)}`, logs });
        serverInfo = initResp.result?.serverInfo || null;

        // Send `initialized` notification (required by spec)
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

        const listResp = await Promise.race([
          request('tools/list', {}),
          new Promise((_, rej) => setTimeout(() => rej(new Error('tools/list timeout')), timeoutMs - 2000)),
        ]);
        if (listResp.error) return finish({ ok: false, error: `tools/list error: ${JSON.stringify(listResp.error)}`, logs, serverInfo });
        tools = listResp.result?.tools || [];

        finish({ ok: true, tools, logs });
      } catch (e) {
        finish({ ok: false, error: e.message, logs });
      }
    })();
  });
}

app.post('/api/mcp/probe', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing id' });
  const servers = getMcpIndex();
  const srv = servers.find(s => s.id === id);
  if (!srv) return res.status(404).json({ error: 'server not found' });
  try {
    const result = await probeMcpServer(srv);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: `probe crashed: ${e.message}` });
  }
});

// ─── MCP Inspector subprocess management ─────────────────────────────────────
// activeInspectors: Map<serverId, { child, url, logs[], startedAt, exited, exitCode, exitedAt, clientPort, serverPort }>
const activeInspectors = new Map();
const INSPECTOR_BASE_CLIENT_PORT = 6274;
const INSPECTOR_BASE_SERVER_PORT = 6277;
let inspectorPortOffset = 0;

function readMcpJsonForServer(srv) {
  try {
    if (!srv.configFile || !fs.existsSync(srv.configFile)) return null;
    const raw = fs.readFileSync(srv.configFile, 'utf8');
    if (!srv.configFile.toLowerCase().endsWith('.json')) return null;
    const data = JSON.parse(raw);
    const map = data.mcpServers || data;
    if (!map || typeof map !== 'object') return null;
    if (map[srv.identifier]) return map[srv.identifier];
    if (map[srv.name]) return map[srv.name];
    return null;
  } catch (_) { return null; }
}

// Directory for inspector config files
const INSPECTOR_TMP_DIR = path.join(__dirname, '.inspector-configs');
try { fs.mkdirSync(INSPECTOR_TMP_DIR, { recursive: true }); } catch (_) {}

function buildInspectorCommand(srv) {
  const cfg = readMcpJsonForServer(srv) || {};
  const command = cfg.command || srv.command;
  const cmdArgs = cfg.args || [];
  const url = cfg.url || srv.url;
  const env = cfg.env || {};

  if (url) {
    return {
      mode: 'http',
      cmd: 'npx',
      args: ['-y', '@modelcontextprotocol/inspector', '--transport', 'http', url],
      childEnv: env,
      describe: `[HTTP] ${url}`,
      configFile: null,
    };
  }
  if (command) {
    // KEY FIX FOR WINDOWS:
    // Inspector's UI/proxy somewhere converts arg strings through a layer that
    // treats backslashes as escapes ("\U" "\.m" etc collapse). This corrupts
    // paths like "C:\Users\me\.claude\mcp\server.py" → "Usersme.claudemcpserver.py".
    //
    // Workaround: convert any arg that looks like a Windows file path to use
    // forward slashes (e.g. "C:/Users/me/.claude/mcp/my_server.py"). Python, Node,
    // and most MCP servers all accept forward slashes on Windows.
    const normalizeArgForInspector = (arg) => {
      const s = String(arg);
      // Detect Windows-style path: drive letter or UNC, OR contains backslash
      if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || /\\/.test(s)) {
        return s.replace(/\\/g, '/');
      }
      return s;
    };
    const normalizedArgs = cmdArgs.map(normalizeArgForInspector);

    // Use Inspector's --config + --server JSON config file. We still keep this
    // for clarity, even though the real fix is the forward-slash normalization.
    const safeId = String(srv.id).replace(/[^a-zA-Z0-9._-]/g, '_');
    const configPath = path.join(INSPECTOR_TMP_DIR, `${safeId}.json`);
    const configBody = {
      mcpServers: {
        [safeId]: {
          command: String(command),
          args: normalizedArgs,
          env: { ...env },
        },
      },
    };
    try {
      fs.writeFileSync(configPath, JSON.stringify(configBody, null, 2), 'utf8');
    } catch (e) {
      return {
        mode: 'stdio',
        cmd: 'npx',
        args: ['-y', '@modelcontextprotocol/inspector', command, ...normalizedArgs],
        childEnv: env,
        describe: `[STDIO] ${command} ${normalizedArgs.join(' ')}`,
        configFile: null,
      };
    }
    return {
      mode: 'stdio',
      cmd: 'npx',
      args: [
        '-y', '@modelcontextprotocol/inspector',
        '--config', configPath,
        '--server', safeId,
      ],
      childEnv: env,
      describe: `[STDIO] ${command} ${normalizedArgs.join(' ')}  (via config ${path.basename(configPath)})`,
      configFile: configPath,
    };
  }
  return null;
}

app.post('/api/mcp/inspect', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing id' });
  const servers = getMcpIndex();
  const srv = servers.find(s => s.id === id);
  if (!srv) return res.status(404).json({ error: 'server not found' });

  const existing = activeInspectors.get(id);
  if (existing && !existing.exited) {
    return res.json({
      ok: true, alreadyRunning: true, id, url: existing.url,
      pid: existing.child?.pid, describe: existing.describe,
      logs: existing.logs.slice(-30).join(''),
      clientPort: existing.clientPort, serverPort: existing.serverPort,
    });
  }

  const built = buildInspectorCommand(srv);
  if (!built) {
    const isPlugin = srv.source === 'cursor-project';
    const hint = isPlugin
      ? 'This is an IDE-managed plugin MCP (e.g. Figma). It is launched internally by Cursor and cannot be started externally via command line. Use Probe instead to inspect its tools.'
      : 'No command or url found in the server config. Check its mcp.json for a valid "command" or "url" field.';
    return res.status(400).json({ error: 'cannot determine how to launch this server', reason: isPlugin ? 'ide-plugin' : 'no-config', hint });
  }

  const clientPort = INSPECTOR_BASE_CLIENT_PORT + inspectorPortOffset;
  const serverPort = INSPECTOR_BASE_SERVER_PORT + inspectorPortOffset;
  inspectorPortOffset = (inspectorPortOffset + 1) % 30;

  console.log(`[Inspector] Launching for "${id}": ${built.describe}`);
  console.log(`[Inspector] cmd: ${built.cmd} ${built.args.join(' ')}`);
  if (built.configFile) {
    console.log(`[Inspector] using config file: ${built.configFile}`);
  }

  let child;
  try {
    child = spawn(built.cmd, built.args, {
      shell: true,
      env: {
        ...process.env,
        ...built.childEnv,
        CLIENT_PORT: String(clientPort),
        SERVER_PORT: String(serverPort),
        MCP_AUTO_OPEN_ENABLED: 'false',
      },
    });
  } catch (e) {
    return res.status(500).json({ error: `spawn failed: ${e.message}` });
  }

  const state = {
    child, url: null, logs: [], startedAt: Date.now(),
    describe: built.describe, mode: built.mode,
    clientPort, serverPort, exited: false,
  };
  activeInspectors.set(id, state);

  const onData = (chunk) => {
    const text = chunk.toString();
    state.logs.push(text);
    if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
    if (!state.url) {
      const m = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s'"]*/i);
      if (m) state.url = m[0];
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    state.exitedAt = Date.now();
    console.log(`[Inspector] "${id}" exited with code=${code} signal=${signal}`);
  });
  child.on('error', (err) => {
    state.exited = true;
    state.error = err.message;
    state.exitedAt = Date.now();
    console.error(`[Inspector] "${id}" error: ${err.message}`);
  });

  const deadline = Date.now() + 25000;
  const poll = () => {
    if (state.exited) {
      return res.json({
        ok: false, error: `inspector process exited before URL detected (code=${state.exitCode})`,
        logs: state.logs.slice(-30).join(''),
      });
    }
    if (state.url) {
      return res.json({
        ok: true, id, url: state.url, pid: child.pid,
        describe: state.describe, mode: state.mode,
        logs: state.logs.slice(-30).join(''),
        clientPort, serverPort,
      });
    }
    if (Date.now() > deadline) {
      return res.json({
        ok: false, error: 'timeout waiting for Inspector URL (25s)',
        logs: state.logs.slice(-30).join(''),
        clientPort, serverPort, pid: child.pid,
        hint: `Inspector may still be starting. Try opening http://127.0.0.1:${clientPort} manually.`,
      });
    }
    setTimeout(poll, 250);
  };
  setTimeout(poll, 250);
});

app.get('/api/mcp/inspect/status', (req, res) => {
  const { id } = req.query;
  if (id) {
    const state = activeInspectors.get(id);
    if (!state) return res.json({ running: false });
    return res.json({
      running: !state.exited, exited: state.exited, exitCode: state.exitCode,
      url: state.url, pid: state.child?.pid, describe: state.describe,
      clientPort: state.clientPort, serverPort: state.serverPort,
      logs: state.logs.slice(-30).join(''),
      startedAt: state.startedAt,
    });
  }
  res.json({
    running: [...activeInspectors.entries()]
      .filter(([, s]) => !s.exited)
      .map(([id, s]) => ({ id, url: s.url, pid: s.child?.pid, clientPort: s.clientPort })),
  });
});

app.post('/api/mcp/inspect/stop', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing id' });
  const state = activeInspectors.get(id);
  if (!state) return res.json({ ok: false, error: 'not running' });
  try {
    if (state.child && !state.exited) {
      if (process.platform === 'win32') {
        try { execFile('taskkill', ['/PID', String(state.child.pid), '/T', '/F'], () => {}); }
        catch { state.child.kill('SIGKILL'); }
      } else {
        state.child.kill('SIGTERM');
      }
    }
  } catch (e) { /* ignore */ }
  activeInspectors.delete(id);
  res.json({ ok: true });
});

app.post('/api/mcp/search', (req, res) => {
  const { query } = req.body;
  if (!query || !query.trim()) return res.json([]);

  const servers = getMcpIndex();
  const results = [];
  for (const srv of servers) {
    let hasToolHit = false;
    for (const tool of srv.tools) {
      const score = scoreMcpTool(tool, srv.name, query);
      if (score > 0) {
        hasToolHit = true;
        results.push({
          ...tool,
          server: srv.name,
          serverId: srv.id,
          score,
          resultType: 'tool',
        });
      }
    }

    if (!hasToolHit) {
      const srvScore = scoreMcpServer(srv, query);
      if (srvScore > 0) {
        results.push({
          name: srv.name,
          description: srv.description || `${srv.transport || 'stdio'} server` + (srv.command ? `: ${srv.command}` : ''),
          params: [],
          server: srv.name,
          serverId: srv.id,
          source: srv.source,
          enabled: srv.enabled,
          toolCount: srv.toolCount,
          resourceCount: srv.resourceCount,
          score: srvScore,
          resultType: 'server',
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  res.json(results.slice(0, 20));
});

app.get('/api/mcp/stats', (req, res) => {
  const servers = getMcpIndex();
  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const totalResources = servers.reduce((sum, s) => sum + s.resourceCount, 0);
  res.json({
    serverCount: servers.length,
    totalTools,
    totalResources,
    servers: servers.map(s => ({ name: s.name, tools: s.toolCount, resources: s.resourceCount })),
  });
});

// ─── LLM Skill Selection (claude_agent_sdk) ──────────────────────────────────

const LLM_SELECTOR_SCRIPT = path.join(__dirname, 'llm_selector.py');
const LLM_TIMEOUT_MS = 90000;
const LLM_PRE_FILTER_COUNT = 40;
let llmAvailable = null;

function checkLlmAvailable() {
  return new Promise((resolve) => {
    execFile('python', ['-c', 'from claude_agent_sdk import query; print("ok")'], { timeout: 15000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === 'ok');
    });
  });
}

function buildSkillSummaries(skills) {
  return skills.map(s => ({
    name: s.name,
    description: (s.description || '').slice(0, 120),
    triggers: (s.triggers || []).slice(0, 6),
    source: s.source,
  }));
}

app.get('/api/llm/status', async (req, res) => {
  if (llmAvailable === null) llmAvailable = await checkLlmAvailable();
  res.json({ available: llmAvailable, engine: 'claude_agent_sdk' });
});

app.post('/api/llm-search', async (req, res) => {
  const { query: userQuery } = req.body;
  if (!userQuery || !userQuery.trim()) return res.json({ results: [], error: 'Empty query' });

  if (llmAvailable === null) llmAvailable = await checkLlmAvailable();
  if (!llmAvailable) {
    const index = getIndex();
    const fallbackResults = index
      .map(skill => ({ ...skill, content: undefined, score: scoreSkill(skill, userQuery) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    return res.json({ results: fallbackResults, error: null, fallback: true, fallbackReason: 'claude_agent_sdk not available' });
  }

  const index = getIndex();
  const preScored = index
    .map(s => ({ ...s, _kwScore: scoreSkill(s, userQuery) }))
    .sort((a, b) => b._kwScore - a._kwScore)
    .slice(0, LLM_PRE_FILTER_COUNT);
  const uniqueSkills = [];
  const seenNames = new Set();
  for (const s of preScored) {
    if (!seenNames.has(s.name)) { seenNames.add(s.name); uniqueSkills.push(s); }
  }
  const summaries = buildSkillSummaries(uniqueSkills);
  const input = JSON.stringify({ query: userQuery, skills: summaries });

  const startTime = Date.now();

  const child = execFile('python', [LLM_SELECTOR_SCRIPT], {
    timeout: LLM_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }, (err, stdout, stderr) => {
    const latencyMs = Date.now() - startTime;

    if (err) {
      console.error('[LLM] Error:', err.message);
      if (stderr) console.error('[LLM] Stderr:', stderr.slice(0, 500));
      const fallbackResults = index
        .map(skill => ({ ...skill, content: undefined, score: scoreSkill(skill, userQuery) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      return res.json({ results: fallbackResults, error: null, fallback: true, fallbackReason: err.message, latencyMs });
    }

    try {
      const parsed = JSON.parse(stdout);

      if (parsed.error && (!parsed.results || !parsed.results.length)) {
        console.error('[LLM] Selector returned error:', parsed.error.slice(0, 300));
        let category = 'error';
        const lowErr = parsed.error.toLowerCase();
        if (lowErr.includes('402') || lowErr.includes('quota') || lowErr.includes('credit') || lowErr.includes('billing')) {
          category = 'quota';
        } else if (lowErr.includes('401') || lowErr.includes('unauthorized') || lowErr.includes('authentication')) {
          category = 'auth';
        } else if (lowErr.includes('429') || lowErr.includes('rate limit')) {
          category = 'ratelimit';
        } else if (lowErr.includes('timed out') || lowErr.includes('timeout')) {
          category = 'timeout';
        } else if (lowErr.includes('not found') || lowErr.includes('enoent')) {
          category = 'cli-missing';
        }
        const fallbackResults = index
          .map(skill => ({ ...skill, content: undefined, score: scoreSkill(skill, userQuery) }))
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);
        return res.json({
          results: fallbackResults,
          error: null,
          fallback: true,
          fallbackReason: parsed.error,
          fallbackCategory: category,
          latencyMs,
        });
      }

      const llmResults = (parsed.results || []).map(r => {
        const skill = index.find(s => s.name === r.name);
        return {
          name: r.name,
          score: r.score || 0,
          reason: r.reason || '',
          source: skill ? skill.source : '',
          filePath: skill ? skill.filePath : '',
          description: skill ? skill.description : '',
          triggers: skill ? (skill.triggers || []).slice(0, 5) : [],
        };
      });
      res.json({ results: llmResults, error: parsed.error, fallback: false, latencyMs });
    } catch (e) {
      console.error('[LLM] JSON parse error:', e.message, 'stdout:', stdout.slice(0, 300));
      const fallbackResults = index
        .map(skill => ({ ...skill, content: undefined, score: scoreSkill(skill, userQuery) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      res.json({ results: fallbackResults, error: null, fallback: true, fallbackReason: 'Response parse error', latencyMs });
    }
  });

  child.stdin.write(input);
  child.stdin.end();
});

// ─── Skill Visualizer (skill-visualizer 学习导览 HTML 生成) ───────────────────
// 把每个 Skill 文件夹生成一份「Skill 学习导览」单页 HTML，缓存到 viz-cache/。
// 生成靠 skill_visualizer_gen.py（调 claude CLI 产出数据 + build-report.py 合成）。
// 增量策略：对比 SKILL.md 与已生成 HTML 的 mtime，仅在缺失或过期时才重新生成。

const VIZ_CACHE_DIR = path.join(__dirname, 'viz-cache');
const VIZ_GEN_SCRIPT = path.join(__dirname, 'skill_visualizer_gen.py');
const VIZ_VISUALIZER_DIR = path.join(__dirname, 'skill-visualizer');
const VIZ_AUTO = process.env.SKILL_VIZ_AUTO !== '0';            // 启动后是否自动批量生成
const VIZ_CONCURRENCY = Math.max(1, parseInt(process.env.SKILL_VIZ_CONCURRENCY || '1', 10));
const VIZ_TIMEOUT_SEC = Math.max(60, parseInt(process.env.SKILL_VIZ_TIMEOUT || '300', 10));

// id -> { status, error, htmlFile, skillMtime, queuePos, startedAt, finishedAt }
// status: 'queued' | 'generating' | 'done' | 'error'
const vizState = new Map();
const vizQueue = [];        // 待生成的 skill id 队列
let vizActive = 0;          // 正在生成的数量
let vizDisabledReason = ''; // 若 claude 不可用等原因，整体停用并记录原因

function ensureVizCacheDir() {
  try { fs.mkdirSync(VIZ_CACHE_DIR, { recursive: true }); } catch (_) {}
}

function vizHtmlPath(id) {
  const safe = String(id).replace(/[^\w.\-]+/g, '__');
  return path.join(VIZ_CACHE_DIR, safe + '.html');
}

function vizSkillDir(skill) {
  return path.dirname(skill.filePath);
}

// 是否需要(重新)生成：缺失 → 'missing'；SKILL.md 比 HTML 新 → 'stale'；否则 null。
function vizNeedsGen(skill) {
  const html = vizHtmlPath(skill.id);
  let htmlStat;
  try { htmlStat = fs.statSync(html); } catch (_) { return 'missing'; }
  if (skill.mtime && htmlStat.mtimeMs < skill.mtime) return 'stale';
  return null;
}

function vizGetSkill(id) {
  return getIndex().find(s => s.id === id);
}

function vizEnqueue(id, front = false) {
  if (vizDisabledReason) return;
  const cur = vizState.get(id);
  if (cur && (cur.status === 'generating')) return;
  if (vizQueue.includes(id)) {
    if (front) { vizQueue.splice(vizQueue.indexOf(id), 1); vizQueue.unshift(id); }
    return;
  }
  if (front) vizQueue.unshift(id); else vizQueue.push(id);
  vizState.set(id, { ...(cur || {}), status: 'queued', error: null });
  pumpViz();
}

function pumpViz() {
  if (vizDisabledReason) return;
  while (vizActive < VIZ_CONCURRENCY && vizQueue.length > 0) {
    const id = vizQueue.shift();
    vizGenerateOne(id);
  }
}

function vizGenerateOne(id) {
  const skill = vizGetSkill(id);
  if (!skill) {
    vizState.set(id, { status: 'error', error: 'skill not found' });
    return;
  }
  vizActive++;
  const html = vizHtmlPath(id);
  const skillDir = vizSkillDir(skill);
  vizState.set(id, { status: 'generating', error: null, htmlFile: html, startedAt: Date.now(), skillMtime: skill.mtime });

  execFile('python', [
    VIZ_GEN_SCRIPT,
    '--skill-dir', skillDir,
    '--name', skill.name,
    '--output', html,
    '--visualizer-dir', VIZ_VISUALIZER_DIR,
    '--timeout', String(VIZ_TIMEOUT_SEC),
  ], {
    timeout: (VIZ_TIMEOUT_SEC + 40) * 1000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }, (err, stdout, stderr) => {
    vizActive--;
    let result = null;
    const out = (stdout || '').trim();
    if (out) {
      const lastLine = out.split('\n').filter(Boolean).pop();
      try { result = JSON.parse(lastLine); } catch (_) {}
    }

    if (result && result.ok) {
      vizState.set(id, { status: 'done', error: null, htmlFile: html, skillMtime: skill.mtime, finishedAt: Date.now() });
      console.log(`[viz] done: ${id} (${result.bytes || 0} bytes)`);
    } else {
      const emsg = (result && result.error) || (err && err.message) || (stderr || '').slice(0, 300) || 'unknown error';
      vizState.set(id, { status: 'error', error: emsg, skillMtime: skill.mtime, finishedAt: Date.now() });
      console.error(`[viz] error: ${id} → ${emsg}`);
      // claude CLI 不存在 → 整体停用，避免对上百个 skill 反复失败
      if (/claude CLI 未找到|not found in PATH|claude.*未找到|ENOENT/i.test(emsg)) {
        vizDisabledReason = 'claude CLI 不可用，已停止自动生成（可设置 PATH 后重启）';
        const pending = vizQueue.splice(0, vizQueue.length);
        for (const pid of pending) vizState.set(pid, { status: 'error', error: vizDisabledReason });
        console.error(`[viz] disabled: ${vizDisabledReason}`);
      }
    }
    pumpViz();
  });
}

// 启动时：扫描所有 skill，已有且未过期的标记 done，其余入队。
function initViz() {
  ensureVizCacheDir();
  if (!VIZ_AUTO) {
    console.log('[viz] 自动生成已关闭 (SKILL_VIZ_AUTO=0)，将按需生成');
  }
  if (!fs.existsSync(VIZ_GEN_SCRIPT)) {
    vizDisabledReason = 'skill_visualizer_gen.py 缺失';
    console.error('[viz] ' + vizDisabledReason);
    return;
  }
  const index = getIndex();
  let queued = 0, fresh = 0;
  for (const skill of index) {
    const need = vizNeedsGen(skill);
    if (!need) {
      vizState.set(skill.id, { status: 'done', error: null, htmlFile: vizHtmlPath(skill.id), skillMtime: skill.mtime });
      fresh++;
    } else if (VIZ_AUTO) {
      vizQueue.push(skill.id);
      vizState.set(skill.id, { status: 'queued', error: null, _reason: need });
      queued++;
    }
  }
  console.log(`[viz] 缓存命中 ${fresh} 个，待生成 ${queued} 个（并发 ${VIZ_CONCURRENCY}）`);
  if (VIZ_AUTO) pumpViz();
}

// 查询某个 skill 的可视化状态（带按需入队 + 过期检测 + 提升优先级）
app.get('/api/skill/visualization', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'missing id' });
  const skill = vizGetSkill(id);
  if (!skill) return res.status(404).json({ error: 'skill not found' });

  const html = vizHtmlPath(id);
  let st = vizState.get(id);

  // 运行时编辑过 SKILL.md → 已生成的 HTML 过期，重新入队
  if (st && st.status === 'done') {
    const need = vizNeedsGen(skill);
    if (need === 'stale' && !vizDisabledReason) {
      vizEnqueue(id, true);
      st = vizState.get(id);
    }
  }

  // 没有任何状态：磁盘有就标 done，否则按需入队
  if (!st) {
    if (!vizNeedsGen(skill)) {
      st = { status: 'done', htmlFile: html, skillMtime: skill.mtime };
      vizState.set(id, st);
    } else if (vizDisabledReason) {
      st = { status: 'error', error: vizDisabledReason };
      vizState.set(id, st);
    } else {
      vizEnqueue(id, true);
      st = vizState.get(id);
    }
  } else if (st.status === 'queued' && !vizDisabledReason) {
    // 用户主动点了，提到队首优先生成
    if (vizQueue.includes(id) && vizQueue[0] !== id) vizEnqueue(id, true);
  }

  const ready = st.status === 'done' && fs.existsSync(html);
  const queuePos = st.status === 'queued' ? (vizQueue.indexOf(id) + 1) : 0;
  res.json({
    id,
    status: ready ? 'done' : st.status,
    ready,
    error: st.error || null,
    queuePos,
    queueTotal: vizQueue.length,
    active: vizActive,
    disabledReason: vizDisabledReason || null,
    htmlUrl: ready ? `/api/skill/visualization/html?id=${encodeURIComponent(id)}` : null,
  });
});

// 返回已生成的可视化 HTML（直接渲染进 iframe）
app.get('/api/skill/visualization/html', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('missing id');
  const skill = vizGetSkill(id);
  if (!skill) return res.status(404).send('skill not found');
  const html = vizHtmlPath(id);
  if (!fs.existsSync(html)) return res.status(409).send('visualization not ready');
  res.sendFile(html);
});

// 强制重新生成（忽略缓存）
app.post('/api/skill/visualization/regenerate', (req, res) => {
  const id = (req.body && req.body.id) || req.query.id;
  if (!id) return res.status(400).json({ error: 'missing id' });
  const skill = vizGetSkill(id);
  if (!skill) return res.status(404).json({ error: 'skill not found' });
  if (vizDisabledReason) return res.json({ ok: false, error: vizDisabledReason });
  try { fs.unlinkSync(vizHtmlPath(id)); } catch (_) {}
  vizState.delete(id);
  vizEnqueue(id, true);
  res.json({ ok: true, status: 'queued' });
});

// 可视化总体进度
app.get('/api/viz/stats', (req, res) => {
  let done = 0, queued = 0, generating = 0, error = 0;
  for (const st of vizState.values()) {
    if (st.status === 'done') done++;
    else if (st.status === 'queued') queued++;
    else if (st.status === 'generating') generating++;
    else if (st.status === 'error') error++;
  }
  res.json({
    enabled: VIZ_AUTO && !vizDisabledReason,
    disabledReason: vizDisabledReason || null,
    concurrency: VIZ_CONCURRENCY,
    total: vizState.size,
    done, queued, generating, error,
    queueLength: vizQueue.length,
    active: vizActive,
  });
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Translation API (MyMemory free service, no API key) ────────────────────
// LRU-ish cache to avoid repeat round-trips. Key: `${target}|${text}`
const translationCache = new Map();
const TRANSLATION_CACHE_MAX = 5000;

function cacheGetTranslation(key) {
  if (!translationCache.has(key)) return null;
  const v = translationCache.get(key);
  // refresh LRU position
  translationCache.delete(key);
  translationCache.set(key, v);
  return v;
}
function cacheSetTranslation(key, value) {
  translationCache.set(key, value);
  if (translationCache.size > TRANSLATION_CACHE_MAX) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
}

// Detect if a string is "mostly Chinese" (CJK ratio > 30%)
function detectLanguage(text) {
  const s = String(text || '');
  if (!s.trim()) return 'unknown';
  let cjk = 0, ascii = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
    else if (code >= 0x20 && code <= 0x7e) ascii++;
  }
  if (cjk === 0 && ascii === 0) return 'unknown';
  return (cjk / Math.max(1, cjk + ascii)) > 0.3 ? 'zh' : 'en';
}

// Optional HTTP/HTTPS proxy via env (e.g. HTTPS_PROXY=http://your-proxy:8080)
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

if (PROXY_URL) console.log(`[translate] HTTP proxy detected: ${PROXY_URL}`);

// Make an HTTPS GET via CONNECT method through an HTTP proxy.
// Returns Promise<{status, headers, body: string}>
function fetchViaProxy(targetUrl, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(PROXY_URL);
    const dest = new URL(targetUrl);
    const isHttps = dest.protocol === 'https:';
    const destHost = dest.hostname;
    const destPort = dest.port || (isHttps ? 443 : 80);

    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${destHost}:${destPort}`,
      headers: { Host: `${destHost}:${destPort}`, 'Proxy-Connection': 'Keep-Alive' },
      timeout: timeoutMs,
    });

    const timer = setTimeout(() => {
      try { connectReq.destroy(new Error('proxy CONNECT timeout')); } catch (_) {}
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        return reject(new Error(`proxy CONNECT returned ${res.statusCode}`));
      }
      // Tunnel established; now do HTTPS GET through the tunneled socket
      const lib = isHttps ? https : http;
      const req = lib.request({
        host: destHost,
        port: destPort,
        method: 'GET',
        path: dest.pathname + dest.search,
        headers: { Host: destHost, 'User-Agent': 'skill-selector/1.0', Accept: 'application/json' },
        socket, agent: false, timeout: timeoutMs,
      }, (resp) => {
        let body = '';
        resp.setEncoding('utf8');
        resp.on('data', (chunk) => { body += chunk; });
        resp.on('end', () => {
          clearTimeout(timer);
          resolve({ status: resp.statusCode, headers: resp.headers, body });
        });
        resp.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end();
    });
    connectReq.once('error', (e) => { clearTimeout(timer); reject(e); });
    connectReq.end();
  });
}

function fetchDirect(targetUrl, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const dest = new URL(targetUrl);
    const lib = dest.protocol === 'https:' ? https : http;
    const req = lib.request(targetUrl, { method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json' } }, (resp) => {
      let body = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => { body += c; });
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body }));
      resp.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function translateViaMyMemory(text, sourceLang, targetLang) {
  const langpair = `${sourceLang}|${targetLang}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;
  try {
    const r = PROXY_URL ? await fetchViaProxy(url, { timeoutMs: 10000 }) : await fetchDirect(url, { timeoutMs: 10000 });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const data = JSON.parse(r.body);
    const translated = data?.responseData?.translatedText;
    const status = data?.responseStatus;
    if (!translated) throw new Error('empty response');
    // MyMemory sometimes returns an error message in translatedText with quota info
    const isError = (
      status !== 200 ||
      /MYMEMORY WARNING/i.test(translated) ||
      /QUERY LENGTH LIMIT/i.test(translated) ||
      /quota/i.test(translated)
    );
    if (isError) throw new Error(translated.slice(0, 200));
    return { ok: true, translated, provider: 'mymemory' };
  } catch (e) {
    throw e;
  }
}

app.post('/api/translate', async (req, res) => {
  const { text, target } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'missing text' });
  }
  if (!['zh', 'en'].includes(target)) {
    return res.status(400).json({ ok: false, error: 'target must be zh or en' });
  }
  // Cap text length for free API limits
  const MAX_LEN = 500;
  const sliced = text.length > MAX_LEN;
  const input = sliced ? text.slice(0, MAX_LEN) : text;

  const source = detectLanguage(input);
  if (source === target) {
    return res.json({ ok: true, translated: text, sourceLang: source, sameLang: true });
  }
  if (source === 'unknown') {
    return res.json({ ok: false, error: 'cannot detect source language', sourceLang: 'unknown' });
  }

  const sourceLang = source === 'zh' ? 'zh-CN' : 'en';
  const targetLang = target === 'zh' ? 'zh-CN' : 'en';

  const cacheKey = `${targetLang}|${input}`;
  const cached = cacheGetTranslation(cacheKey);
  if (cached) return res.json({ ok: true, translated: cached, sourceLang: source, cached: true, truncated: sliced });

  try {
    const r = await translateViaMyMemory(input, sourceLang, targetLang);
    cacheSetTranslation(cacheKey, r.translated);
    res.json({ ok: true, translated: r.translated, sourceLang: source, provider: r.provider, truncated: sliced });
  } catch (e) {
    res.json({
      ok: false,
      error: `MyMemory: ${e.message}`,
      sourceLang: source,
      hint: 'Translation provider failed. Original text is preserved on UI.',
    });
  }
});

const PORT = 3791;
const BIND_HOST = '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  console.log(`\n🎯 Skill & MCP Manager running at http://localhost:${PORT}  (bound to ${BIND_HOST} — LAN access blocked)\n`);
  const index = getIndex();
  const mcp = getMcpIndex();
  const totalTools = mcp.reduce((sum, s) => sum + s.toolCount, 0);
  console.log(`📦 Loaded ${index.length} skills from ${getSkillDirs().length} directories`);
  console.log(`🔌 Loaded ${mcp.length} MCP servers with ${totalTools} tools`);
  try { initViz(); } catch (e) { console.error('[viz] init failed:', e.message); }
});

function killAllInspectors() {
  for (const [id, state] of activeInspectors.entries()) {
    if (state.child && !state.exited) {
      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(state.child.pid), '/T', '/F'], () => {});
        } else {
          state.child.kill('SIGTERM');
        }
        console.log(`[Inspector] killed "${id}" on shutdown`);
      } catch (_) {}
    }
  }
}
process.on('SIGINT',  () => { killAllInspectors(); process.exit(0); });
process.on('SIGTERM', () => { killAllInspectors(); process.exit(0); });
process.on('exit',    () => { killAllInspectors(); });
