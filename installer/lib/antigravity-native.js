'use strict';

// Antigravity CLI/Desktop/IDE plugin staging & helper routines.
//
// Antigravity reads plugins from ~/.gemini/config/plugins/<name>/ via
// `agy plugin install <dir>`. Dynamically hooked installs ship hooks/ +
// hooks.json with NO rules/ directory (rules/AGENTS.md is injected
// unconditionally every turn and would override `off`/`manual`/"stop caveman").
// `--no-hooks` and Bun without a Node >=18 runtime fall back to staging
// static `rules/AGENTS.md` without hooks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const PORTABLE = require('./portable-process');
const { transformOpencodeAgentFrontmatter } = require('./opencode-agent');

const AGY_PLUGIN_NAME = 'caveman';
const AGY_SKILL_DIRS = [
  'caveman',
  'ultracave',
  'megacave',
  'caveman-commit',
  'caveman-review',
  'caveman-help',
  'caveman-stats',
  'caveman-compress',
  'cavecrew',
];
const AGY_AGENT_FILES = [
  'cavecrew-investigator.md',
  'cavecrew-builder.md',
  'cavecrew-reviewer.md',
];
const AGY_HOOK_FILES = [
  'package.json',
  'caveman-antigravity.js',
  'caveman-config.js',
  'caveman-parse.js',
  'caveman-stats.js',
];
const RULE_FRONTMATTER = '---\ntrigger: always_on\n---\n\n';
const DEFAULT_PLUGIN_META = {
  name: AGY_PLUGIN_NAME,
  displayName: 'Caveman',
  description: 'Ultra-compressed communication mode. Shortens prose while preserving technical terms, code, commands, and exact errors.',
  logo: 'assets/caveman.svg',
};

function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function resolveAgyCommand({ home = os.homedir(), hasCmd, platform = process.platform } = {}) {
  if (typeof hasCmd === 'function' && hasCmd('agy')) return 'agy';
  const binDir = path.join(home, '.gemini', 'bin');
  const names = platform === 'win32' ? ['agy.exe', 'agy'] : ['agy', 'agy.exe'];
  for (const name of names) {
    const candidate = path.join(binDir, name);
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
}

function transformAntigravityAgent(content) {
  if (typeof content !== 'string') return content;
  const out = transformOpencodeAgentFrontmatter(content);
  let splitIdx = -1;
  if (out.startsWith('---\n')) {
    const fmEnd = out.indexOf('\n---', 4);
    if (fmEnd >= 0) splitIdx = fmEnd + 4;
  }
  const head = splitIdx >= 0 ? out.slice(0, splitIdx) : '';
  let body = splitIdx >= 0 ? out.slice(splitIdx) : out;

  body = body
    .replace(
      '`Grep` for symbols/strings. `Glob` for paths. `Read` only specific ranges. `Bash` for `git log -S`/`git grep`/`find` when faster.',
      '`read_file` only specific line ranges. `run_command` for read-only `git grep`/`git log -S`/`find` when faster.',
    )
    .replace(/`Read`/g, '`read_file`')
    .replace(/`Edit`/g, '`edit_file`')
    .replace(/`Write`/g, '`write_file`')
    .replace(/`Bash`/g, '`run_command`');

  return head + body;
}

// Quote only the Node executable path (if not bare `node`), leaving the relative
// ./hooks/caveman-antigravity.js path unquoted so Windows `cmd.exe /c` accepts it.
// Never emit $PLUGIN_ROOT or ${PLUGIN_ROOT} (`agy plugin validate --strict` rejects it).
function formatAntigravityHookCommand(nodeBin, eventArg) {
  const exe = typeof nodeBin === 'string' && nodeBin.trim() ? nodeBin.trim() : 'node';
  const prefix = exe === 'node' ? 'node' : `"${exe}"`;
  return `${prefix} ./hooks/caveman-antigravity.js ${eventArg}`;
}

function buildAntigravityHooksJson(nodeBin) {
  return {
    [AGY_PLUGIN_NAME]: {
      SessionStart: [
        {
          type: 'command',
          command: formatAntigravityHookCommand(nodeBin, 'session-start'),
          timeout: 10,
        },
      ],
      PreInvocation: [
        {
          type: 'command',
          command: formatAntigravityHookCommand(nodeBin, 'pre-invocation'),
          timeout: 10,
        },
      ],
    },
  };
}

function findNodeOnPath(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return PORTABLE.resolveWindowsCommand('node', env);
  }
  try {
    const r = child_process.spawnSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8', env });
    const candidate = (r.stdout || '').trim().split(/\r?\n/, 1)[0];
    if (r.status === 0 && candidate && path.isAbsolute(candidate)) {
      return path.resolve(candidate);
    }
  } catch (_) {}
  return null;
}

function resolveAntigravityHookNode({
  opts,
  isBun = false,
  absoluteNodePath,
  nodeMeetsFloor,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (opts && (opts.withHooks === false || opts.minimal)) return null;
  if (opts && opts.hookNode) return opts.hookNode;
  if (isBun) {
    // Never stamp Bun's execPath as a Node hook runner.
    const candidate = findNodeOnPath(env, platform);
    if (candidate && (typeof nodeMeetsFloor !== 'function' || nodeMeetsFloor(candidate))) {
      return candidate;
    }
    return null;
  }
  return typeof absoluteNodePath === 'function' ? absoluteNodePath() : process.execPath;
}

function stageAntigravityPlugin({ repoRoot, pluginDir, node = 'node', withHooks = true }) {
  fs.mkdirSync(pluginDir, { recursive: true });

  const checkedInManifest = path.join(repoRoot, 'plugins', 'antigravity', 'plugin.json');
  const svgCandidates = [
    path.join(repoRoot, 'plugins', 'antigravity', 'assets', 'caveman.svg'),
    path.join(repoRoot, 'plugins', 'caveman', 'assets', 'caveman.svg'),
  ];
  const svgSource = svgCandidates.find((p) => fs.existsSync(p));
  if (svgSource) {
    fs.mkdirSync(path.join(pluginDir, 'assets'), { recursive: true });
    fs.copyFileSync(svgSource, path.join(pluginDir, 'assets', 'caveman.svg'));
  }

  if (fs.existsSync(checkedInManifest)) {
    fs.copyFileSync(checkedInManifest, path.join(pluginDir, 'plugin.json'));
  } else {
    const meta = { ...DEFAULT_PLUGIN_META };
    if (!svgSource) delete meta.logo;
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(meta, null, 2) + '\n');
  }

  for (const name of AGY_SKILL_DIRS) {
    const srcSkill = path.join(repoRoot, 'skills', name, 'SKILL.md');
    if (!fs.existsSync(srcSkill)) continue;
    const dstSkillDir = path.join(pluginDir, 'skills', name);
    fs.mkdirSync(dstSkillDir, { recursive: true });
    fs.copyFileSync(srcSkill, path.join(dstSkillDir, 'SKILL.md'));

    if (name === 'caveman-compress') {
      const srcScripts = path.join(repoRoot, 'skills', 'caveman-compress', 'scripts');
      if (fs.existsSync(srcScripts)) {
        const dstScripts = path.join(dstSkillDir, 'scripts');
        fs.mkdirSync(dstScripts, { recursive: true });
        for (const entry of fs.readdirSync(srcScripts, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
          fs.copyFileSync(path.join(srcScripts, entry.name), path.join(dstScripts, entry.name));
        }
      }
    }
  }

  const agentsDir = path.join(pluginDir, 'agents');
  for (const file of AGY_AGENT_FILES) {
    const srcAgent = path.join(repoRoot, 'agents', file);
    if (!fs.existsSync(srcAgent)) continue;
    fs.mkdirSync(agentsDir, { recursive: true });
    const adapted = transformAntigravityAgent(fs.readFileSync(srcAgent, 'utf8'));
    fs.writeFileSync(path.join(agentsDir, file), adapted);
  }

  const hooksDir = path.join(pluginDir, 'hooks');
  const hooksJson = path.join(pluginDir, 'hooks.json');
  const rulesDir = path.join(pluginDir, 'rules');

  if (withHooks) {
    fs.rmSync(rulesDir, { recursive: true, force: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const file of AGY_HOOK_FILES) {
      fs.copyFileSync(path.join(repoRoot, 'src', 'hooks', file), path.join(hooksDir, file));
    }
    fs.writeFileSync(hooksJson, JSON.stringify(buildAntigravityHooksJson(node), null, 2) + '\n');
  } else {
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(hooksJson, { force: true });
    fs.mkdirSync(rulesDir, { recursive: true });
    const ruleBody = fs.readFileSync(path.join(repoRoot, 'src', 'rules', 'caveman-activate.md'), 'utf8');
    fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), RULE_FRONTMATTER + ruleBody);
  }
}

function outputMentionsCavemanPlugin(stdout) {
  const text = (stdout || '').trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    const lists = [];
    if (Array.isArray(parsed)) lists.push(parsed);
    else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.plugins)) lists.push(parsed.plugins);
      if (Array.isArray(parsed.imports)) lists.push(parsed.imports);
    }
    for (const list of lists) {
      if (list.some((item) => item && item.name === AGY_PLUGIN_NAME)) return true;
    }
    if (lists.length > 0) return false;
  } catch (_) { /* fall back to text probe */ }
  return /"name":\s*"caveman"/.test(text) || /(^|\s)caveman(\s|$)/m.test(text);
}

function agyHasCaveman(agyCmd, captureSpawn, spawnOk) {
  let probe = captureSpawn(agyCmd, ['plugin', 'list', '--json']);
  if (!spawnOk(probe)) {
    probe = captureSpawn(agyCmd, ['plugin', 'list']);
  }
  return spawnOk(probe) && outputMentionsCavemanPlugin(probe.stdout);
}

function isOrgDisabledError(stdout, stderr) {
  return /plugins are disabled by your organization/i.test(`${stdout || ''}\n${stderr || ''}`);
}

function shouldSkipRedundantSkillCopy(provider, { home = os.homedir(), installedProviders = [] } = {}) {
  const hasUnifiedPlugin = installedProviders.includes('antigravity-cli')
    || fs.existsSync(path.join(home, '.gemini', 'config', 'plugins', AGY_PLUGIN_NAME, 'plugin.json'));
  if (!hasUnifiedPlugin) return false;
  if (provider === 'antigravity-2') return true;
  if (provider === 'antigravity') {
    return fs.existsSync(path.join(home, '.gemini', 'antigravity-ide', '.ide_migration'))
      || fs.existsSync(path.join(home, '.gemini', 'config', '.migrated'));
  }
  return false;
}

module.exports = {
  AGY_PLUGIN_NAME,
  AGY_SKILL_DIRS,
  AGY_AGENT_FILES,
  AGY_HOOK_FILES,
  RULE_FRONTMATTER,
  resolveAgyCommand,
  transformAntigravityAgent,
  formatAntigravityHookCommand,
  buildAntigravityHooksJson,
  resolveAntigravityHookNode,
  stageAntigravityPlugin,
  agyHasCaveman,
  isOrgDisabledError,
  shouldSkipRedundantSkillCopy,
};
