#!/usr/bin/env node
// caveman — Antigravity SessionStart + PreInvocation hook adapter
//
// Usage in hooks.json:
//   node ./hooks/caveman-antigravity.js session-start
//   node ./hooks/caveman-antigravity.js pre-invocation
//
// Mode state lives in caveman-config.js (.caveman-sessions/<id>.mode/.prev +
// .caveman-mode-log.jsonl + .caveman-active) under PLUGIN_DATA / .agents / ~/.gemini.
// Only the lightweight Antigravity turn-dedup cursor sits alongside it in .turn.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function reportDegraded(name, detail) {
  process.stderr.write('caveman: ' + detail + '\n'
    + 'Run `agy plugin update caveman`, or rerun installer for hooks. '
    + 'Continuing without caveman injection.\n');
}

function requireSibling(name, isUsable) {
  let mod;
  try {
    mod = require('./' + name);
  } catch (primary) {
    const message = String((primary && primary.message) || primary);
    if (primary && primary.code === 'MODULE_NOT_FOUND' && message.includes("'./" + name + "'")) {
      try { return require('./' + name + '.cjs'); } catch (e) { /* report primary */ }
    }
    const absent = !fs.existsSync(path.join(__dirname, name + '.js'))
      && !fs.existsSync(path.join(__dirname, name + '.cjs'));
    reportDegraded(name, absent
      ? name + '.js is missing from ' + __dirname + ' — the install is incomplete.'
      : name + ' could not load — ' + message.split('\n')[0]);
    return null;
  }
  if (!isUsable(mod)) {
    reportDegraded(name, name + ' loaded but is missing expected exports — the install is inconsistent.');
    return null;
  }
  return mod;
}

const cavemanConfig = requireSibling('caveman-config', (m) =>
  m && typeof m.getDefaultMode === 'function' && typeof m.safeWriteFlag === 'function'
    && typeof m.recordModeChange === 'function' && typeof m.resolveActiveMode === 'function'
    && typeof m.writeSessionMode === 'function' && Array.isArray(m.VALID_MODES));

// Only attempt caveman-parse when caveman-config loaded so missing caveman-config
// emits a single clear degraded message instead of cascading into caveman-parse.
const cavemanParse = cavemanConfig
  ? requireSibling('caveman-parse', (m) =>
    m && typeof m.parseModeChange === 'function' && m.INDEPENDENT_MODES instanceof Set)
  : null;

const PAYLOAD_WATCHDOG_MS = 2000;
const MAX_CURSOR_BYTES = 512;
const RESET_SOURCES = new Set(['startup', 'clear']);
const SWITCH_LINE = 'Switch: /caveman, /ultracave, /megacave. Off: "stop caveman" or "normal mode".';
const OFF_BANNER = 'CAVEMAN MODE OFF. Respond in normal, clear prose without caveman compression.';

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function formatStepOutput(text) {
  if (!text) return {};
  if (process.env.CAVEMAN_AGY_STEP_FORMAT === 'ephemeral') {
    return { injectSteps: [{ ephemeralMessage: text }] };
  }
  return { injectSteps: [{ systemMessage: { systemMessage: text } }] };
}

function emitText(text) {
  emitJson(formatStepOutput(text));
}

function hashInput(text) {
  return crypto.createHash('sha256').update(typeof text === 'string' ? text : '', 'utf8').digest('hex').slice(0, 16);
}

function isRealDir(dirPath) {
  try {
    const st = fs.lstatSync(dirPath);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch (e) {
    return false;
  }
}

function resolveWorkspaceCwd(data) {
  const roots = Array.isArray(data && data.workspacePaths) ? data.workspacePaths : [];
  const candidate = [data && data.cwd, roots[0], process.cwd()]
    .find((v) => typeof v === 'string' && v.trim() !== '');
  return candidate || process.cwd();
}

function resolveStateDir(cwd) {
  const pluginData = typeof process.env.PLUGIN_DATA === 'string' ? process.env.PLUGIN_DATA.trim() : '';
  if (pluginData) return pluginData;
  const projectAgents = path.join(cwd, '.agents');
  if (isRealDir(projectAgents)) return path.join(projectAgents, '.caveman-state');
  return path.join(os.homedir(), '.gemini', 'config', '.caveman-state');
}

function turnCursorPath(stateDir, sessionId, sessionsDirName) {
  if (sessionId) {
    return path.join(stateDir, sessionsDirName || '.caveman-sessions', sessionId + '.turn');
  }
  return path.join(stateDir, '.caveman-antigravity.turn');
}

// Symlink-safe capped JSON cursor read, symmetric with caveman-config.readFlag().
function readTurnCursor(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size === 0 || st.size > MAX_CURSOR_BYTES) {
      return null;
    }
    const dir = path.dirname(filePath);
    try {
      const dirStat = fs.lstatSync(dir);
      if (dirStat.isSymbolicLink()) {
        const realDir = fs.realpathSync(dir);
        const realStat = fs.statSync(realDir);
        if (!realStat.isDirectory()) return null;
        if (typeof process.getuid === 'function' && realStat.uid !== process.getuid()) return null;
      }
    } catch (e) {
      return null;
    }
    const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const flags = fs.constants.O_RDONLY | O_NOFOLLOW;
    let fd;
    let raw;
    try {
      fd = fs.openSync(filePath, flags);
      const buf = Buffer.alloc(MAX_CURSOR_BYTES);
      const n = fs.readSync(fd, buf, 0, MAX_CURSOR_BYTES, 0);
      raw = buf.slice(0, n).toString('utf8');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.initialized !== 'boolean') {
      return null;
    }
    return {
      initialized: parsed.initialized,
      sessionStartTurn: parsed.sessionStartTurn === true,
      lastInputHash: typeof parsed.lastInputHash === 'string' ? parsed.lastInputHash : '',
      lastInv: typeof parsed.lastInv === 'number' && Number.isFinite(parsed.lastInv) ? parsed.lastInv : 0,
    };
  } catch (e) {
    return null;
  }
}

// Prefer the installed plugin's pinned skills/ before caveman-config's fallback.
function readSkillBody(mode, cfg) {
  const candidates = [];
  const pluginRoot = typeof process.env.PLUGIN_ROOT === 'string' ? process.env.PLUGIN_ROOT.trim() : '';
  if (pluginRoot) candidates.push(path.join(pluginRoot, 'skills', mode, 'SKILL.md'));
  candidates.push(path.join(__dirname, '..', 'skills', mode, 'SKILL.md'));
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
    } catch (e) { /* try next candidate */ }
  }
  return cfg.loadRuleset ? cfg.loadRuleset(mode, __dirname) : null;
}

function thesisForMode(mode, cfg) {
  const body = readSkillBody(mode, cfg);
  if (body) {
    const lines = body.split(/\r?\n/);
    const heading = lines.findIndex((line) => line.trim() === '# ' + mode);
    const line = heading === -1 ? null : lines.slice(heading + 1).find((l) => l.trim());
    if (line) return line.trim();
  }
  return (cfg.thesisLine && cfg.thesisLine(mode, __dirname))
    || 'Respond terse like smart caveman. All technical substance stay. Only fluff die.';
}

function buildRuleset(mode, cfg) {
  const banner = cfg.rulesetBanner ? cfg.rulesetBanner(mode) : 'CAVEMAN MODE ACTIVE — mode: ' + mode;
  const skillBody = readSkillBody(mode, cfg) || (cfg.fallbackRuleset ? cfg.fallbackRuleset(mode, __dirname) : '');
  if (!skillBody) return banner + '\n\n' + thesisForMode(mode, cfg) + '\n\n' + SWITCH_LINE;
  return banner + '\n\n' + skillBody.trimEnd() + '\n\n' + SWITCH_LINE;
}

function reinforcementForMode(mode, cfg) {
  return 'CAVEMAN MODE ACTIVE (' + mode + '). ' + thesisForMode(mode, cfg)
    + ' Answer only what was asked: no unrequested background, lists, examples,'
    + ' walkthroughs, or follow-up offers; give code, steps, or warnings when the'
    + ' task needs them. Security warnings, irreversible actions, multi-step order:'
    + ' normal prose. Technical terms, code, commands, paths, and errors stay exact.';
}

function startMode(sessionCwd, cfg) {
  return cfg.getDefaultMode(sessionCwd);
}

function detectEvent(arg, data) {
  if (arg === 'session-start' || arg === 'SessionStart') return 'SessionStart';
  if (arg === 'pre-invocation' || arg === 'PreInvocation') return 'PreInvocation';
  if (data && (data.hookEventName === 'SessionStart' || data.hookEventName === 'PreInvocation')) {
    return data.hookEventName;
  }
  return arg || '';
}

function runSessionStart(data, timedOut, stateDir, sessionId, cwd, cfg, independentModes) {
  const source = timedOut ? 'unknown' : (data && typeof data.source === 'string' ? data.source : 'startup');
  let mode;
  if (RESET_SOURCES.has(source)) {
    mode = startMode(cwd, cfg);
    cfg.gcSessionStore(stateDir);
  } else {
    const stored = cfg.readSessionModeRaw(stateDir, sessionId);
    mode = (stored && cfg.VALID_MODES.includes(stored)) ? stored : startMode(cwd, cfg);
  }

  const cursorPath = turnCursorPath(stateDir, sessionId, cfg.SESSIONS_DIRNAME);
  const rawInput = data && typeof data.lastUserInput === 'string' ? data.lastUserInput : '';
  const initialHash = rawInput ? hashInput(rawInput) : '';

  if (mode === 'off' || mode === 'manual') {
    cfg.recordModeChange(stateDir, null, sessionId);
    cfg.writeSessionMode(stateDir, sessionId, null);
    cfg.safeWriteFlag(cursorPath, JSON.stringify({
      initialized: true,
      sessionStartTurn: true,
      lastInputHash: initialHash,
      lastInv: 0,
    }));
    emitText('');
    return;
  }

  cfg.recordModeChange(stateDir, mode, sessionId);
  cfg.writeSessionMode(stateDir, sessionId, mode);
  cfg.safeWriteFlag(cursorPath, JSON.stringify({
    initialized: true,
    sessionStartTurn: true,
    lastInputHash: initialHash,
    lastInv: 0,
  }));

  if (independentModes.has(mode)) {
    emitText('CAVEMAN MODE ACTIVE — mode: ' + mode + '. Behavior defined by /caveman-' + mode + ' skill.');
    return;
  }
  emitText(buildRuleset(mode, cfg));
}

function handleStatsCommand(statsMatch, data, sessionId, stateDir) {
  const tailArgs = (statsMatch[1] || '').trim().split(/\s+/).filter(Boolean);
  const statsPath = path.join(__dirname, 'caveman-stats.js');
  let block;
  try {
    if (!fs.existsSync(statsPath)) throw new Error('missing caveman-stats.js');
    const argv = [statsPath, '--host', 'antigravity'];
    const transcript = (data && (data.transcriptPath || data.transcript_path)) || '';
    if (typeof transcript === 'string' && transcript) argv.push('--session-file', transcript);
    if (sessionId) argv.push('--session-id', sessionId);
    if (tailArgs.includes('--share')) argv.push('--share');
    if (tailArgs.includes('--all')) argv.push('--all');
    const sinceIdx = tailArgs.indexOf('--since');
    if (sinceIdx !== -1 && tailArgs[sinceIdx + 1]) argv.push('--since', tailArgs[sinceIdx + 1]);
    const execEnv = { ...process.env };
    if (stateDir) execEnv.PLUGIN_DATA = stateDir;
    block = execFileSync(process.execPath, argv, {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
      env: execEnv,
    }).trim();
  } catch (e) {
    block = 'caveman-stats: could not run stats script.\nTry manually: node ' + statsPath;
  }
  emitText('Print this stats block verbatim inside a fenced code block. Say nothing else.\n\n' + block);
}

function runPreInvocation(data, stateDir, sessionId, cwd, cfg, parse) {
  const inv = data && typeof data.invocationNum === 'number' && Number.isFinite(data.invocationNum)
    ? data.invocationNum
    : 0;
  const rawPrompt = data && typeof data.lastUserInput === 'string'
    ? data.lastUserInput
    : (data && typeof data.prompt === 'string' ? data.prompt : '');
  const inputHash = hashInput(rawPrompt);
  const cursorPath = turnCursorPath(stateDir, sessionId, cfg.SESSIONS_DIRNAME);
  const cursor = readTurnCursor(cursorPath);

  // R-1a locked fast bailout: invocationNum resets to 0 on every new user turn
  // and increments (> 0) on tool-loop steps while lastUserInput stays identical.
  if (cursor && cursor.initialized && inv > 0 && inputHash === cursor.lastInputHash) {
    emitText('');
    return;
  }

  let selfInitialized = false;
  if (!cursor || !cursor.initialized) {
    const stored = cfg.readSessionModeRaw(stateDir, sessionId);
    if (!stored || !cfg.VALID_MODES.includes(stored)) {
      const initMode = startMode(cwd, cfg);
      cfg.gcSessionStore(stateDir);
      if (initMode === 'off' || initMode === 'manual') {
        cfg.recordModeChange(stateDir, null, sessionId);
        cfg.writeSessionMode(stateDir, sessionId, null);
      } else {
        cfg.recordModeChange(stateDir, initMode, sessionId);
        cfg.writeSessionMode(stateDir, sessionId, initMode);
      }
    }
    selfInitialized = true;
  }

  if (/<scheduled-task\b/i.test(rawPrompt)) {
    emitText('');
    return;
  }

  const isPlanReview = /^\s*\[plan review(?:\s+due)?\]/i.test(rawPrompt);
  let prompt = rawPrompt.trim().toLowerCase().replace(/\s+/g, ' ');
  let skipNaturalLanguage = isPlanReview;
  const envName = /<command-name>\s*([^<\s]+)\s*<\/command-name>/.exec(prompt);
  if (envName) {
    if (/^\/(?:caveman|ultracave\b|megacave\b)/.test(envName[1])) {
      const envArgs = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(prompt);
      const args = envArgs ? envArgs[1].trim() : '';
      prompt = args ? envName[1] + ' ' + args : envName[1];
    } else {
      skipNaturalLanguage = true;
    }
  }

  const writeCursor = () => cfg.safeWriteFlag(cursorPath, JSON.stringify({
    initialized: true,
    sessionStartTurn: false,
    lastInputHash: inputHash,
    lastInv: inv,
  }));

  const statsMatch = /^\/caveman(?::caveman)?-stats(?:\s+(.*))?$/.exec(prompt);
  if (statsMatch) {
    writeCursor();
    handleStatsCommand(statsMatch, data, sessionId, stateDir);
    return;
  }

  const change = parse.parseModeChange(prompt, {
    getDefaultMode: () => cfg.getDefaultMode(cwd),
    skipNaturalLanguage,
  });

  if (change && change.action === 'status') {
    const active = cfg.resolveActiveMode(stateDir, sessionId);
    writeCursor();
    emitText('Report this status verbatim without changing mode: Caveman mode: ' + (active || 'off'));
    return;
  }

  const modeBeforeChange = cfg.resolveActiveMode(stateDir, sessionId);

  let notice = null;
  if (change && change.action === 'unresolved') {
    if (change.independentMode) {
      notice = 'Tell the user ' + change.independentMode + ' mode is set with its own command, '
        + '/caveman-' + change.independentMode + ', not /caveman ' + change.independentMode
        + '. The mode is unchanged.';
    } else {
      notice = 'Tell the user their /caveman argument was not recognized and the mode is '
        + 'unchanged. Modes: /caveman, /ultracave, /megacave. Use /caveman off to deactivate.';
    }
  }

  let setIndependentThisTurn = false;
  let switchedToMode = null;

  if (change && change.action === 'set') {
    const mode = change.mode;
    if (parse.INDEPENDENT_MODES.has(mode)) {
      if (modeBeforeChange && !parse.INDEPENDENT_MODES.has(modeBeforeChange)) {
        cfg.writeSessionPrev(stateDir, sessionId, modeBeforeChange);
      } else if (!modeBeforeChange) {
        cfg.writeSessionPrev(stateDir, sessionId, 'off');
      }
      setIndependentThisTurn = true;
    } else if (mode !== modeBeforeChange) {
      switchedToMode = mode;
    }
    cfg.recordModeChange(stateDir, mode, sessionId);
    cfg.writeSessionMode(stateDir, sessionId, mode);
  } else if (change && change.action === 'clear') {
    cfg.recordModeChange(stateDir, null, sessionId);
    cfg.writeSessionMode(stateDir, sessionId, null);
    cfg.clearSessionPrev(stateDir, sessionId);
    if (modeBeforeChange) notice = OFF_BANNER;
  }

  let activeMode = cfg.resolveActiveMode(stateDir, sessionId);

  if (activeMode && parse.INDEPENDENT_MODES.has(activeMode) && !setIndependentThisTurn) {
    const prev = cfg.readSessionPrev(stateDir, sessionId);
    cfg.clearSessionPrev(stateDir, sessionId);
    if (prev && !parse.INDEPENDENT_MODES.has(prev) && prev !== 'off') {
      cfg.recordModeChange(stateDir, prev, sessionId);
      cfg.writeSessionMode(stateDir, sessionId, prev);
      activeMode = prev;
      switchedToMode = prev;
    } else {
      cfg.recordModeChange(stateDir, null, sessionId);
      cfg.writeSessionMode(stateDir, sessionId, null);
      activeMode = null;
      if (!change) notice = OFF_BANNER;
    }
  }

  const sameSessionStartPrompt = Boolean(
    cursor && cursor.sessionStartTurn && inv === 0
      && (cursor.lastInputHash === '' || cursor.lastInputHash === inputHash)
  );
  writeCursor();

  if (sameSessionStartPrompt && !selfInitialized && !switchedToMode && !setIndependentThisTurn && !notice) {
    emitText('');
    return;
  }

  const prose = Boolean(activeMode) && !parse.INDEPENDENT_MODES.has(activeMode) && cfg.getDefaultMode(cwd) !== 'off';
  const independentBanner = setIndependentThisTurn
    ? 'CAVEMAN MODE ACTIVE — mode: ' + activeMode + '. Behavior defined by /caveman-' + activeMode + ' skill.'
    : null;
  const ruleset = (selfInitialized || switchedToMode) && prose ? buildRuleset(activeMode, cfg) : null;
  const getReinforce = cfg.getReinforce || (() => true);
  const reinforce = !sameSessionStartPrompt && !selfInitialized && !switchedToMode && prose && getReinforce(cwd)
    ? reinforcementForMode(activeMode, cfg)
    : null;

  emitText([notice, independentBanner, ruleset, reinforce].filter(Boolean).join('\n\n'));
}

function handle(rawPayload, timedOut) {
  try {
    if (!cavemanConfig || !cavemanParse) {
      emitText('');
      return;
    }
    let data = {};
    let parseOk = false;
    if (rawPayload) {
      try {
        const parsed = JSON.parse(rawPayload);
        if (parsed && typeof parsed === 'object') {
          data = parsed;
          parseOk = true;
        }
      } catch (e) { /* invalid payload treated below */ }
    }
    const event = detectEvent(process.argv[2], data);
    if (!event) {
      emitText('');
      return;
    }
    const cwd = resolveWorkspaceCwd(data);
    const stateDir = resolveStateDir(cwd);
    const sessionId = cavemanConfig.validateSessionId(data.conversationId || data.session_id);

    if (event === 'SessionStart') {
      runSessionStart(data, timedOut, stateDir, sessionId, cwd, cavemanConfig, cavemanParse.INDEPENDENT_MODES);
      return;
    }
    if (event === 'PreInvocation') {
      if (timedOut && !parseOk) {
        emitText('');
        return;
      }
      runPreInvocation(data, stateDir, sessionId, cwd, cavemanConfig, cavemanParse);
      return;
    }
    emitText('');
  } catch (e) {
    emitText('');
  }
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => process.exit(0));
}

if (process.stdin.isTTY) {
  handle('', false);
} else {
  let input = '';
  let done = false;
  let watchdog;
  const finish = (timedOut) => {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    try { process.stdin.pause(); } catch (e) {}
    try { process.stdin.unref(); } catch (e) {}
    handle(input, timedOut === true);
  };
  watchdog = setTimeout(() => finish(true), PAYLOAD_WATCHDOG_MS);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    try { JSON.parse(input); } catch (e) { return; }
    finish(false);
  });
  process.stdin.on('error', () => finish(false));
  process.stdin.on('end', () => finish(false));
}
