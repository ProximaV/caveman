// Antigravity CLI (`agy`): the installer stages a hooked plugin
// (plugin.json, assets/caveman.svg, hooks.json, hooks/*, skills/*, adapted
// agents/* — and NO rules/) and hands it to `agy plugin install`. With
// `--no-hooks` or under Bun without Node, it omits hooks and falls back to
// static `rules/AGENTS.md`. A stub `agy` records argv and snapshots the
// staged directory, since the installer deletes its staging copy afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { nodeStub, stubEnv } from '../../packages/cli/tests/harness/stub-bin.mjs';
import { isolatedEnv } from './_isolated-env.mjs';

const require = createRequire(import.meta.url);
const antigravityNative = require('../../installer/lib/antigravity-native.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALLER = path.join(ROOT, 'installer/install.js');
const SKILLS = ['caveman', 'ultracave', 'megacave', 'caveman-commit', 'caveman-review', 'caveman-help', 'caveman-stats', 'caveman-compress', 'cavecrew'];
const AGENTS = ['cavecrew-investigator.md', 'cavecrew-builder.md', 'cavecrew-reviewer.md'];
const HOOKS = ['package.json', 'caveman-antigravity.js', 'caveman-config.js', 'caveman-parse.js', 'caveman-stats.js'];

function findRealAgy() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(os.homedir(), '.gemini', 'bin', `agy${ext}`),
    `agy${ext}`,
  ];
  for (const bin of candidates) {
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) continue;
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (probe.status === 0) return bin;
  }
  return null;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman agy '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const log = path.join(dir, 'agy.log');
  const installed = path.join(dir, 'installed');
  nodeStub(path.join(dir, 'bin'), 'agy', `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(ARGV) + '\\n');
if (ARGV[1] === 'install') {
  if (process.env.AGY_FAIL === '1') process.exit(1);
  if (process.env.AGY_ORG_DISABLED === '1') {
    console.error('Error: plugins are disabled by your organization policy.');
    process.exit(1);
  }
  fs.rmSync(${JSON.stringify(installed)}, { recursive: true, force: true });
  fs.cpSync(ARGV[2], ${JSON.stringify(installed)}, { recursive: true });
}
if (ARGV[1] === 'list') {
  if (process.env.AGY_LIST_PLAIN === '1' && ARGV.includes('--json')) process.exit(2);
  const present = fs.existsSync(${JSON.stringify(installed)});
  if (ARGV.includes('--json')) {
    console.log(JSON.stringify({ plugins: present ? [{ name: 'caveman', version: '4.1.0', enabled: true }] : [] }, null, 2));
  } else {
    console.log(present ? 'caveman  4.1.0  enabled' : 'No plugins installed.');
  }
}
if (ARGV[1] === 'uninstall') fs.rmSync(${JSON.stringify(installed)}, { recursive: true, force: true });
`);
  // Only the stub (and node, which Windows shims need by name) on PATH.
  const env = stubEnv(isolatedEnv(home), path.join(dir, 'bin'));
  const run = (args, extra = {}) => spawnSync(process.execPath, [INSTALLER, ...args, '--non-interactive'], {
    encoding: 'utf8', cwd: dir, env: { ...env, ...extra },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { dir, home, env, run, calls, installed };
}

test('default install stages hooked plugin (skills, adapted agents, hooks, no rules/) and passes strict agy validation', (t) => {
  const { run, calls, installed } = fixture(t);
  const r = run(['--only', 'antigravity-cli']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [install] = calls().filter((argv) => argv[1] === 'install');
  assert.deepEqual(install.slice(0, 2), ['plugin', 'install']);
  assert.equal(path.basename(install[2]), 'caveman');
  assert.equal(fs.existsSync(install[2]), false, 'staging copy is cleaned up');

  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'plugin.json'), 'utf8')).name, 'caveman');
  assert.equal(fs.existsSync(path.join(installed, 'assets', 'caveman.svg')), true);
  assert.equal(fs.existsSync(path.join(installed, 'rules')), false, 'hooked bundle must not ship rules/AGENTS.md');

  for (const id of SKILLS) assert.ok(fs.existsSync(path.join(installed, 'skills', id, 'SKILL.md')), id);
  assert.ok(fs.existsSync(path.join(installed, 'skills', 'caveman-compress', 'scripts', 'compress.py')));
  assert.equal(fs.existsSync(path.join(installed, 'skills', 'caveman-compress', 'scripts', '__pycache__')), false);

  for (const agent of AGENTS) {
    assert.equal(
      fs.readFileSync(path.join(installed, 'agents', agent), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'plugins/antigravity/agents', agent), 'utf8'),
      `adapted agent ${agent} matches checked-in plugins/antigravity/agents/`,
    );
  }

  for (const hookFile of HOOKS) {
    assert.equal(
      fs.readFileSync(path.join(installed, 'hooks', hookFile), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'src/hooks', hookFile), 'utf8'),
    );
  }

  const hooksJson = JSON.parse(fs.readFileSync(path.join(installed, 'hooks.json'), 'utf8'));
  const startCmd = hooksJson.caveman.SessionStart[0].command;
  const preCmd = hooksJson.caveman.PreInvocation[0].command;
  assert.doesNotMatch(startCmd, /\$PLUGIN_ROOT|\$\{PLUGIN_ROOT\}/);
  assert.doesNotMatch(preCmd, /\$PLUGIN_ROOT|\$\{PLUGIN_ROOT\}/);
  assert.match(startCmd, /\s\.\/hooks\/caveman-antigravity\.js session-start$/);
  assert.match(preCmd, /\s\.\/hooks\/caveman-antigravity\.js pre-invocation$/);
  assert.ok(startCmd.startsWith(`"${process.execPath}" `) || startCmd.startsWith('"'));

  const agyBin = findRealAgy();
  if (agyBin) {
    const val = spawnSync(agyBin, ['plugin', 'validate', installed, '--strict', '--json'], {
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(val.status, 0, val.stdout + val.stderr);
    const report = JSON.parse(val.stdout);
    assert.equal(report.name, 'caveman');
    assert.deepEqual(report.findings, []);
  }
});

test('--no-hooks stages static rules/AGENTS.md fallback without hooks/, and passes strict agy validation', (t) => {
  const { run, installed } = fixture(t);
  const r = run(['--only', 'antigravity-cli', '--no-hooks']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(installed, 'hooks')), false);
  assert.equal(fs.existsSync(path.join(installed, 'hooks.json')), false);
  assert.equal(
    fs.readFileSync(path.join(installed, 'rules', 'AGENTS.md'), 'utf8'),
    antigravityNative.RULE_FRONTMATTER + fs.readFileSync(path.join(ROOT, 'src/rules/caveman-activate.md'), 'utf8'),
  );
  for (const id of SKILLS) assert.ok(fs.existsSync(path.join(installed, 'skills', id, 'SKILL.md')), id);

  const agyBin = findRealAgy();
  if (agyBin) {
    const val = spawnSync(agyBin, ['plugin', 'validate', installed, '--strict', '--json'], {
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(val.status, 0, val.stdout + val.stderr);
    const report = JSON.parse(val.stdout);
    assert.equal(report.name, 'caveman');
    assert.deepEqual(report.findings, []);
  }
});

test('Bun fallback drops hooks (never stamps bun) and stages static rules/AGENTS.md', (t) => {
  assert.equal(antigravityNative.resolveAntigravityHookNode({ opts: {}, isBun: true, env: { PATH: '' } }), null);

  const { dir, env, installed } = fixture(t);
  const preload = path.join(dir, 'bun-preload.cjs');
  fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'bun', { value: '1.2.0' });\n");
  const r = spawnSync(process.execPath, ['--require', preload, INSTALLER, '--only', 'antigravity-cli', '--non-interactive'], {
    encoding: 'utf8', cwd: dir, env,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(installed, 'hooks')), false);
  assert.equal(fs.existsSync(path.join(installed, 'hooks.json')), false);
  assert.ok(fs.existsSync(path.join(installed, 'rules', 'AGENTS.md')));
});

test('`agy` on PATH and off-PATH ~/.gemini/bin/agy(.exe) are detected without --only', (t) => {
  const { dir, env, calls } = fixture(t);
  // Keep macOS system apps (Cursor.app etc.) out of detection.
  const preload = path.join(dir, 'hide-system-apps.cjs');
  fs.writeFileSync(preload, `const fs = require('fs'); const exists = fs.existsSync; fs.existsSync = p => String(p).startsWith('/Applications/') ? false : exists(p);`);
  const r = spawnSync(process.execPath, ['--require', preload, INSTALLER, '--non-interactive'], { encoding: 'utf8', cwd: dir, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(calls().some((argv) => argv[1] === 'install'));

  // Off-PATH binary at $HOME/.gemini/bin/agy(.exe)
  const offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-agy-offpath-'));
  t.after(() => fs.rmSync(offDir, { recursive: true, force: true }));
  const offHome = path.join(offDir, 'home');
  const agyBinDir = path.join(offHome, '.gemini', 'bin');
  fs.mkdirSync(agyBinDir, { recursive: true });
  const offBin = path.join(agyBinDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
  fs.writeFileSync(offBin, process.platform === 'win32' ? 'stub' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(antigravityNative.resolveAgyCommand({ home: offHome, hasCmd: () => false }), offBin);

  const offEnv = {
    ...isolatedEnv(offHome),
    PATH: process.platform === 'win32' ? path.dirname(process.execPath) : '/usr/bin:/bin',
  };
  const offRun = spawnSync(process.execPath, ['--require', preload, INSTALLER, '--dry-run', '--non-interactive'], {
    encoding: 'utf8', cwd: offDir, env: offEnv,
  });
  assert.equal(offRun.status, 0, offRun.stdout + offRun.stderr);
  assert.match(offRun.stdout, /Antigravity CLI detected/);
  assert.ok(offRun.stdout.includes(offBin));
});

test('org pluginControls disable error warns and reports skipped with exit 0', (t) => {
  const { run } = fixture(t);
  const r = run(['--only', 'antigravity-cli'], { AGY_ORG_DISABLED: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /disabled by your organization/);
  assert.match(r.stdout, /skipped:/);
  assert.match(r.stdout, /antigravity-cli — plugins disabled by organization/);
});

test('a failed agy install is reported', (t) => {
  const { run } = fixture(t);
  const r = run(['--only', 'antigravity-cli'], { AGY_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /antigravity-cli/);
});

test('uninstall probes plugin list --json (with plain-text fallback) and removes only when installed', (t) => {
  const { run, calls, installed } = fixture(t);
  assert.equal(run(['--uninstall']).status, 0);
  assert.equal(calls().some((argv) => argv[1] === 'uninstall'), false);

  assert.equal(run(['--only', 'antigravity-cli']).status, 0);
  assert.equal(run(['--uninstall']).status, 0);
  assert.ok(calls().some((argv) => argv[0] === 'plugin' && argv[1] === 'list' && argv[2] === '--json'));
  assert.deepEqual(calls().filter((argv) => argv[1] === 'uninstall'), [['plugin', 'uninstall', 'caveman']]);
  assert.equal(fs.existsSync(installed), false);

  // Plain-text fallback if `plugin list --json` returns non-zero
  assert.equal(run(['--only', 'antigravity-cli']).status, 0);
  assert.equal(run(['--uninstall'], { AGY_LIST_PLAIN: '1' }).status, 0);
  assert.equal(fs.existsSync(installed), false);
});

test('skips redundant antigravity-2 and migrated antigravity skill copies when unified plugin is installed', (t) => {
  const { home, run } = fixture(t);
  const r2 = run(['--only', 'antigravity-cli', '--only', 'antigravity-2']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /skipped redundant skills copy/);
  assert.equal(fs.existsSync(path.join(home, '.gemini', 'config', 'skills')), false);

  // Unmigrated `antigravity` still installs legacy skills copy, whereas `.ide_migration` skips it
  fs.mkdirSync(path.join(home, '.gemini', 'config', 'plugins', 'caveman'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'config', 'plugins', 'caveman', 'plugin.json'), '{"name":"caveman"}\n');
  assert.equal(antigravityNative.shouldSkipRedundantSkillCopy('antigravity', { home }), false);

  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-ide'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'antigravity-ide', '.ide_migration'), '');
  assert.equal(antigravityNative.shouldSkipRedundantSkillCopy('antigravity', { home }), true);
  const rIde = run(['--only', 'antigravity']);
  assert.equal(rIde.status, 0, rIde.stdout + rIde.stderr);
  assert.match(rIde.stdout, /skipped redundant skills copy/);
  assert.equal(fs.existsSync(path.join(home, '.gemini', 'antigravity', 'skills')), false);
});
