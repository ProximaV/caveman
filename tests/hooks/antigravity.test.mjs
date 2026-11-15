import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcHook = path.join(root, 'src/hooks/caveman-antigravity.js');
const pluginRoot = path.join(root, 'plugins/antigravity');
const bundledHook = path.join(pluginRoot, 'hooks/caveman-antigravity.js');

function extractText(parsed) {
  const step = parsed && Array.isArray(parsed.injectSteps) ? parsed.injectSteps[0] : null;
  if (!step || typeof step !== 'object') return '';
  if (step.systemMessage && typeof step.systemMessage.systemMessage === 'string') {
    return step.systemMessage.systemMessage;
  }
  if (typeof step.ephemeralMessage === 'string') {
    return step.ephemeralMessage;
  }
  return '';
}

function cleanHookEnv(dir, stateDir, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: path.join(dir, 'xdg'),
    PLUGIN_DATA: stateDir,
  };
  for (const key of [
    'CAVEMAN_DEFAULT_MODE',
    'CAVEMAN_REINFORCE',
    'CAVEMAN_AGY_STEP_FORMAT',
    'PLUGIN_ROOT',
    'CLAUDE_PLUGIN_ROOT',
    'CURSOR_PROJECT_DIR',
    'CLAUDE_CONFIG_DIR',
  ]) {
    delete env[key];
  }
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-agy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const hookPath = options.hookPath || srcHook;
  const sessionId = options.sessionId || 'conv-test-1';

  const modePath = (sid = sessionId) => path.join(stateDir, '.caveman-sessions', `${sid}.mode`);
  const prevPath = (sid = sessionId) => path.join(stateDir, '.caveman-sessions', `${sid}.prev`);
  const cursorPath = (sid = sessionId) => path.join(stateDir, '.caveman-sessions', `${sid}.turn`);
  const readMode = (sid = sessionId) => fs.readFileSync(modePath(sid), 'utf8');

  const run = (eventArg, payload = {}, extraEnv = {}, cliArg = eventArg) => {
    const env = cleanHookEnv(dir, stateDir, { ...options.env, ...extraEnv });
    const fullPayload = { conversationId: sessionId, cwd: project, ...payload };
    const args = cliArg ? [hookPath, cliArg] : [hookPath];
    const result = spawnSync(process.execPath, args, {
      cwd: dir,
      env,
      input: typeof payload === 'string' ? payload : JSON.stringify(fullPayload),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    assert.ok(result.stdout.length > 0, 'hook must emit valid JSON object');
    const parsed = JSON.parse(result.stdout);
    return {
      parsed,
      text: extractText(parsed),
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  };

  return { dir, project, stateDir, sessionId, modePath, prevPath, cursorPath, readMode, run };
}

function findAgyBinary() {
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

test('SessionStart respects default, ultra/mega modes, wenyan-lite alias, off, manual, and independent commit', (t) => {
  const base = fixture(t);
  const rDefault = base.run('session-start', { source: 'startup' });
  assert.match(rDefault.text, /^CAVEMAN MODE ACTIVE — mode: caveman/);
  assert.match(rDefault.text, /Switch: \/caveman, \/ultracave, \/megacave/);
  assert.equal(base.readMode(), 'caveman');
  assert.equal(fs.readFileSync(path.join(base.stateDir, '.caveman-active'), 'utf8'), 'caveman');
  const cursor = JSON.parse(fs.readFileSync(base.cursorPath(), 'utf8'));
  assert.equal(cursor.initialized, true);
  assert.equal(cursor.sessionStartTurn, true);

  for (const [envMode, expectedMode] of [
    ['ultracave', 'ultracave'],
    ['megacave', 'megacave'],
    ['wenyan-lite', 'megacave'],
  ]) {
    const f = fixture(t, { env: { CAVEMAN_DEFAULT_MODE: envMode } });
    const r = f.run('session-start', { source: 'startup' });
    assert.match(r.text, new RegExp(`^CAVEMAN MODE ACTIVE — mode: ${expectedMode}`));
    assert.equal(f.readMode(), expectedMode);
  }

  for (const quietMode of ['off', 'manual']) {
    const f = fixture(t, { env: { CAVEMAN_DEFAULT_MODE: quietMode } });
    const r = f.run('session-start', { source: 'startup' });
    assert.deepEqual(r.parsed, {});
    assert.equal(f.readMode(), 'off');
  }

  const commitFixture = fixture(t, { env: { CAVEMAN_DEFAULT_MODE: 'commit' } });
  const rCommit = commitFixture.run('session-start', { source: 'startup' });
  assert.equal(
    rCommit.text,
    'CAVEMAN MODE ACTIVE — mode: commit. Behavior defined by /caveman-commit skill.',
  );
  assert.equal(commitFixture.readMode(), 'commit');
});

test('SessionStart honors repo-local .caveman.json off via cwd and workspacePaths[0], and handles resume vs clear', (t) => {
  const fCwd = fixture(t);
  fs.writeFileSync(path.join(fCwd.project, '.caveman.json'), '{"defaultMode":"off"}');
  const rCwd = fCwd.run('session-start', { source: 'startup', cwd: fCwd.project });
  assert.deepEqual(rCwd.parsed, {});
  assert.equal(fCwd.readMode(), 'off');

  const fWs = fixture(t);
  fs.writeFileSync(path.join(fWs.project, '.caveman.json'), '{"defaultMode":"off"}');
  const rWs = fWs.run('session-start', { source: 'startup', cwd: undefined, workspacePaths: [fWs.project] });
  assert.deepEqual(rWs.parsed, {});
  assert.equal(fWs.readMode(), 'off');

  const fLifecycle = fixture(t);
  fLifecycle.run('session-start', { source: 'startup', lastUserInput: 'hi' });
  fLifecycle.run('pre-invocation', { invocationNum: 0, lastUserInput: '/ultracave' });
  assert.equal(fLifecycle.readMode(), 'ultracave');

  const rResume = fLifecycle.run('session-start', { source: 'resume' });
  assert.match(rResume.text, /^CAVEMAN MODE ACTIVE — mode: ultracave/);
  assert.equal(fLifecycle.readMode(), 'ultracave');

  const rClear = fLifecycle.run('session-start', { source: 'clear' });
  assert.match(rClear.text, /^CAVEMAN MODE ACTIVE — mode: caveman/);
  assert.equal(fLifecycle.readMode(), 'caveman');
});

test('SessionStart + Turn-1 PreInvocation deduplicates ordinary prompt, preserves Turn-1 switch/stop', (t) => {
  const f1 = fixture(t);
  const start = f1.run('session-start', { source: 'startup', lastUserInput: 'explain foo' });
  assert.match(start.text, /^CAVEMAN MODE ACTIVE — mode: caveman/);
  const turn1 = f1.run('pre-invocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'explain foo' });
  assert.deepEqual(turn1.parsed, {}, 'Turn-1 ordinary prompt must not duplicate SessionStart ruleset');

  // When SessionStart had no lastUserInput, first PreInvocation still deduplicates ordinary prompt.
  const f2 = fixture(t);
  f2.run('session-start', { source: 'startup' });
  const turn1EmptyHash = f2.run('pre-invocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'check status' });
  assert.deepEqual(turn1EmptyHash.parsed, {});

  // Turn-1 explicit /ultracave overrides SessionStart suppression and switches mode.
  const fSwitch = fixture(t);
  fSwitch.run('session-start', { source: 'startup', lastUserInput: '/ultracave' });
  const rUltra = fSwitch.run('pre-invocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: '/ultracave' });
  assert.match(rUltra.text, /^CAVEMAN MODE ACTIVE — mode: ultracave/);
  assert.equal(fSwitch.readMode(), 'ultracave');

  // Turn-1 natural-language deactivation overrides SessionStart and emits OFF banner.
  const fStop = fixture(t);
  fStop.run('session-start', { source: 'startup', lastUserInput: 'stop caveman' });
  const rStop = fStop.run('pre-invocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'stop caveman' });
  assert.match(rStop.text, /^CAVEMAN MODE OFF\./);
  assert.equal(fStop.readMode(), 'off');
});

test('PreInvocation self-initializes when SessionStart never ran (IDE path) and supports ephemeral format', (t) => {
  const f = fixture(t);
  const r1 = f.run('pre-invocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'refactor parser' });
  assert.match(r1.text, /^CAVEMAN MODE ACTIVE — mode: caveman/);
  assert.equal(f.readMode(), 'caveman');

  const rEph = f.run(
    'pre-invocation',
    { invocationNum: 0, initialNumSteps: 3, lastUserInput: 'next turn question' },
    { CAVEMAN_AGY_STEP_FORMAT: 'ephemeral' },
  );
  assert.ok(typeof rEph.parsed.injectSteps?.[0]?.ephemeralMessage === 'string');
  assert.match(rEph.text, /^CAVEMAN MODE ACTIVE \(caveman\)\./);

  const fManual = fixture(t, { env: { CAVEMAN_DEFAULT_MODE: 'manual' } });
  const m1 = fManual.run('pre-invocation', { invocationNum: 0, lastUserInput: 'ordinary prompt' });
  assert.deepEqual(m1.parsed, {});
  assert.equal(fManual.readMode(), 'off');
  const m2 = fManual.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman' });
  assert.match(m2.text, /^CAVEMAN MODE ACTIVE — mode: caveman/);
  assert.equal(fManual.readMode(), 'caveman');
});

test('R-1a tool-loop fast bailout on invocationNum > 0 with matching lastUserInput', (t) => {
  const f = fixture(t);
  f.run('session-start', { source: 'startup', lastUserInput: 'read package.json' });
  f.run('pre-invocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'read package.json' });

  // Mid-turn tool-loop re-invocation keeps same lastUserInput and increments invocationNum.
  const toolLoop1 = f.run('pre-invocation', { invocationNum: 1, initialNumSteps: 3, lastUserInput: 'read package.json' });
  assert.deepEqual(toolLoop1.parsed, {});

  // Even on a second user turn with tool loop: Turn-2 invocationNum=0 injects reinforcement, invocationNum=2 bails.
  const turn2 = f.run('pre-invocation', { invocationNum: 0, initialNumSteps: 5, lastUserInput: '/ultracave' });
  assert.match(turn2.text, /^CAVEMAN MODE ACTIVE — mode: ultracave/);
  const toolLoop2 = f.run('pre-invocation', { invocationNum: 2, initialNumSteps: 7, lastUserInput: '/ultracave' });
  assert.deepEqual(toolLoop2.parsed, {});
  assert.equal(f.readMode(), 'ultracave');
});

test('Turn-2 PreInvocation emits reinforcement and honors CAVEMAN_REINFORCE=0', (t) => {
  const f = fixture(t);
  f.run('session-start', { source: 'startup', lastUserInput: 'turn 1' });
  f.run('pre-invocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'turn 1' });

  const turn2 = f.run('pre-invocation', { invocationNum: 0, initialNumSteps: 5, lastUserInput: 'now explain turn 2' });
  assert.match(turn2.text, /^CAVEMAN MODE ACTIVE \(caveman\)\./);
  assert.match(turn2.text, /Answer only what was asked:/);

  const turn3Disabled = f.run(
    'pre-invocation',
    { invocationNum: 0, initialNumSteps: 7, lastUserInput: 'turn 3 quiet' },
    { CAVEMAN_REINFORCE: '0' },
  );
  assert.deepEqual(turn3Disabled.parsed, {});
});

test('Mid-session switches, status, unresolved args, one-shot /caveman-commit restore, scheduled tasks, and stats fallback', (t) => {
  const f = fixture(t, { hookPath: bundledHook });
  f.run('session-start', { source: 'startup', lastUserInput: 'start' });
  f.run('pre-invocation', { invocationNum: 0, lastUserInput: 'start' });

  const toUltra = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/ultracave' });
  assert.match(toUltra.text, /^CAVEMAN MODE ACTIVE — mode: ultracave/);
  assert.equal(f.readMode(), 'ultracave');

  const toMega = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/megacave' });
  assert.match(toMega.text, /^CAVEMAN MODE ACTIVE — mode: megacave/);
  assert.equal(f.readMode(), 'megacave');

  const statusActive = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman status' });
  assert.equal(statusActive.text, 'Report this status verbatim without changing mode: Caveman mode: megacave');
  assert.equal(f.readMode(), 'megacave');

  const bogus = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman bogus' });
  assert.match(bogus.text, /argument was not recognized and the mode is unchanged/);
  assert.equal(f.readMode(), 'megacave');

  const commitMisrouted = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman commit' });
  assert.match(commitMisrouted.text, /set with its own command, \/caveman-commit, not \/caveman commit/);
  assert.equal(f.readMode(), 'megacave');

  // One-shot /caveman-commit from megacave saves prev and restores megacave next turn.
  const oneShotFromMega = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman-commit' });
  assert.match(oneShotFromMega.text, /CAVEMAN MODE ACTIVE — mode: commit\. Behavior defined by \/caveman-commit skill\./);
  assert.equal(f.readMode(), 'commit');
  assert.equal(fs.readFileSync(f.prevPath(), 'utf8'), 'megacave');

  const afterOneShot = f.run('pre-invocation', { invocationNum: 0, lastUserInput: 'push it' });
  assert.match(afterOneShot.text, /^CAVEMAN MODE ACTIVE — mode: megacave/);
  assert.equal(f.readMode(), 'megacave');
  assert.equal(fs.existsSync(f.prevPath()), false);

  // Deactivate via NL, then /caveman off when already off stays silent.
  const stopNl = f.run('pre-invocation', { invocationNum: 0, lastUserInput: 'stop caveman' });
  assert.match(stopNl.text, /^CAVEMAN MODE OFF\./);
  assert.equal(f.readMode(), 'off');

  const stopAgain = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman off' });
  assert.deepEqual(stopAgain.parsed, {});
  assert.equal(f.readMode(), 'off');

  const statusOff = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman status' });
  assert.equal(statusOff.text, 'Report this status verbatim without changing mode: Caveman mode: off');

  // One-shot /caveman-commit while off saves prev='off' and restores off on the following turn.
  const oneShotFromOff = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman-commit' });
  assert.match(oneShotFromOff.text, /CAVEMAN MODE ACTIVE — mode: commit/);
  assert.equal(f.readMode(), 'commit');
  assert.equal(fs.readFileSync(f.prevPath(), 'utf8'), 'off');

  const afterOffOneShot = f.run('pre-invocation', { invocationNum: 0, lastUserInput: 'continue after commit' });
  assert.match(afterOffOneShot.text, /^CAVEMAN MODE OFF\./);
  assert.equal(f.readMode(), 'off');

  // <scheduled-task> bailout returns {} and preserves mode.
  f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman' });
  assert.equal(f.readMode(), 'caveman');
  const sched = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '<scheduled-task>run check stop caveman</scheduled-task>' });
  assert.deepEqual(sched.parsed, {});
  assert.equal(f.readMode(), 'caveman');

  // Bundled plugin degrades cleanly on /caveman-stats when no Antigravity transcript exists.
  const statsRes = f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/caveman-stats' });
  assert.match(statsRes.text, /^Print this stats block verbatim/);
  assert.match(statsRes.text, /could not run stats script/);
});

test('[plan review], [plan review due], and non-caveman command envelopes skip natural-language triggers', (t) => {
  const f = fixture(t);
  f.run('session-start', { source: 'startup', lastUserInput: 'start' });
  f.run('pre-invocation', { invocationNum: 0, lastUserInput: 'start' });

  for (const prompt of [
    '[plan review] stop caveman and switch to normal mode',
    '[plan review due] be brief and drop caveman',
    '<command-name>/other-tool</command-name> stop caveman',
  ]) {
    const r = f.run('pre-invocation', { invocationNum: 0, lastUserInput: prompt });
    assert.match(r.text, /^CAVEMAN MODE ACTIVE \(caveman\)\./, `should not deactivate on: ${prompt}`);
    assert.equal(f.readMode(), 'caveman');
  }
});

test('resolves state under <cwd>/.agents/.caveman-state when PLUGIN_DATA is unset', (t) => {
  const f = fixture(t);
  const agentsDir = path.join(f.project, '.agents');
  fs.mkdirSync(agentsDir);
  const r = f.run('session-start', { source: 'startup', cwd: f.project }, { PLUGIN_DATA: null });
  assert.match(r.text, /^CAVEMAN MODE ACTIVE — mode: caveman/);
  assert.equal(
    fs.readFileSync(path.join(agentsDir, '.caveman-state', '.caveman-sessions', `${f.sessionId}.mode`), 'utf8'),
    'caveman',
  );
});

test('stdin lifecycle: exits without waiting for EOF once first JSON payload arrives', async (t) => {
  const f = fixture(t);
  const env = cleanHookEnv(f.dir, f.stateDir);
  const child = spawn(process.execPath, [srcHook, 'pre-invocation'], {
    cwd: f.dir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    try { child.stdin.destroy(); } catch {}
    try { child.kill(); } catch {}
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hook hung waiting for stdin EOF')), 3000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  // Keep stdin open (never call child.stdin.end()) just like an Antigravity host pipe.
  child.stdin.write(JSON.stringify({
    conversationId: f.sessionId,
    cwd: f.project,
    invocationNum: 0,
    lastUserInput: 'hello from open pipe',
  }));

  const code = await exited;
  assert.equal(code, 0, stderr);
  const parsed = JSON.parse(stdout);
  assert.match(extractText(parsed), /^CAVEMAN MODE ACTIVE — mode: caveman/);
});

test('stdin lifecycle: payload watchdog exits cleanly with {} when stdin delivers nothing', async (t) => {
  const f = fixture(t);
  const env = cleanHookEnv(f.dir, f.stateDir);
  const child = spawn(process.execPath, [srcHook, 'pre-invocation'], {
    cwd: f.dir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    try { child.stdin.destroy(); } catch {}
    try { child.kill(); } catch {}
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watchdog did not fire within 5s')), 5000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const code = await exited;
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {});
});

test('missing sibling degradation: exits 0 with {} and clean stderr without caveman-config or caveman-parse', (t) => {
  const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-agy-iso-'));
  t.after(() => fs.rmSync(isoDir, { recursive: true, force: true }));
  const hookCopy = path.join(isoDir, 'caveman-antigravity.js');
  fs.copyFileSync(srcHook, hookCopy);
  fs.copyFileSync(path.join(root, 'src/hooks/package.json'), path.join(isoDir, 'package.json'));

  for (const eventArg of ['session-start', 'pre-invocation']) {
    const res = spawnSync(process.execPath, [hookCopy, eventArg], {
      cwd: isoDir,
      input: JSON.stringify({ conversationId: 'conv-missing', cwd: isoDir, lastUserInput: 'hi' }),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.stdout), {});
    assert.match(res.stderr, /caveman-config\.js is missing/);
    assert.doesNotMatch(res.stderr, /MODULE_NOT_FOUND|Require stack:/);
  }

  // Only caveman-parse.js missing
  fs.copyFileSync(path.join(root, 'src/hooks/caveman-config.js'), path.join(isoDir, 'caveman-config.js'));
  const resParseMissing = spawnSync(process.execPath, [hookCopy, 'pre-invocation'], {
    cwd: isoDir,
    input: JSON.stringify({ conversationId: 'conv-missing', cwd: isoDir, lastUserInput: 'hi' }),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(resParseMissing.status, 0);
  assert.deepEqual(JSON.parse(resParseMissing.stdout), {});
  assert.match(resParseMissing.stderr, /caveman-parse\.js is missing/);
  assert.doesNotMatch(resParseMissing.stderr, /MODULE_NOT_FOUND|Require stack:/);
});

test('checked-in plugins/antigravity layout satisfies Antigravity manifest, dialect, and agy strict validator', (t) => {
  const pluginJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  const hooksJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks.json'), 'utf8'));

  assert.equal(pluginJson.name, 'caveman');
  assert.equal(pluginJson.logo, 'assets/caveman.svg');
  assert.equal(fs.existsSync(path.join(pluginRoot, pluginJson.logo)), true);
  assert.equal(fs.existsSync(path.join(pluginRoot, 'rules')), false, 'must not ship rules/');

  assert.ok(hooksJson.caveman && Array.isArray(hooksJson.caveman.SessionStart) && Array.isArray(hooksJson.caveman.PreInvocation));
  for (const entries of [hooksJson.caveman.SessionStart, hooksJson.caveman.PreInvocation]) {
    for (const entry of entries) {
      assert.doesNotMatch(entry.command, /\$PLUGIN_ROOT|\$\{PLUGIN_ROOT\}/);
      assert.match(entry.command, /^\s*node \.\/hooks\/caveman-antigravity\.js /);
    }
  }

  for (const skill of [
    'caveman', 'ultracave', 'megacave',
    'caveman-commit', 'caveman-review', 'caveman-help',
    'caveman-stats', 'cavecrew', 'caveman-compress',
  ]) {
    assert.equal(fs.existsSync(path.join(pluginRoot, 'skills', skill, 'SKILL.md')), true);
  }

  for (const agentFile of ['cavecrew-investigator.md', 'cavecrew-builder.md', 'cavecrew-reviewer.md']) {
    const content = fs.readFileSync(path.join(pluginRoot, 'agents', agentFile), 'utf8');
    assert.doesNotMatch(content, /^model:\s*haiku\b/m);
  }
  const invContent = fs.readFileSync(path.join(pluginRoot, 'agents/cavecrew-investigator.md'), 'utf8');
  assert.match(invContent, /\bread_file\b/);
  assert.match(invContent, /\brun_command\b/);

  const agyBin = findAgyBinary();
  if (!agyBin) {
    t.skip('agy CLI not found on this machine');
    return;
  }

  const val = spawnSync(agyBin, ['plugin', 'validate', pluginRoot, '--strict', '--json'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(val.status, 0, `agy validate failed: ${val.stderr}\n${val.stdout}`);
  const report = JSON.parse(val.stdout);
  assert.equal(report.name, 'caveman');
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.components, {
    agents: 3,
    hooks: 1,
    mcpServers: 0,
    rules: 0,
    sidecars: 0,
    skills: 9,
  });
});

test('bundled plugin /caveman-stats reports Antigravity PLANNER_RESPONSE transcript usage', (t) => {
  const f = fixture(t, { hookPath: bundledHook });
  f.run('session-start', { source: 'startup', lastUserInput: 'start' });
  f.run('pre-invocation', { invocationNum: 0, lastUserInput: 'start' });
  f.run('pre-invocation', { invocationNum: 0, lastUserInput: '/ultracave' });

  const logsDir = path.join(f.dir, 'agy', 'brain', f.sessionId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  const nowIso = new Date().toISOString();
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', output_tokens: 420, cache_read_tokens: 1800, model: 'gemini-2.5-pro', created_at: nowIso }),
  ].join('\n') + '\n');

  const statsRes = f.run('pre-invocation', {
    invocationNum: 0,
    lastUserInput: '/caveman-stats',
    transcriptPath,
  });
  assert.match(statsRes.text, /^Print this stats block verbatim/);
  assert.match(statsRes.text, /Output tokens:\s+420/);
  assert.match(statsRes.text, /Cache-read tokens:\s+1,800/);
  assert.match(statsRes.text, /Mode:\s+ultracave\b/);
  assert.match(statsRes.text, /Savings: unknown/);
  assert.equal(f.readMode(), 'ultracave');
});
