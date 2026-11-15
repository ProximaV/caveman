import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function makeHomeEnv(extra = {}) {
  // Always set a space-free temp home + CAVEMAN_HOME, and set both HOME and
  // USERPROFILE so os.homedir() isolates properly on both POSIX and Windows.
  const root = mkdtempSync(join(tmpdir(), "cave-agy-cli-"));
  const home = join(root, "home");
  const caveHome = join(root, "caveman-home");
  mkdirSync(home, { recursive: true });
  mkdirSync(caveHome, { recursive: true });
  return {
    root,
    home,
    caveHome,
    env: {
      ...process.env,
      NO_COLOR: "1",
      CAVEMAN_TELEMETRY: "0",
      CAVEMAN_OFFLINE: "1",
      HOME: home,
      USERPROFILE: home,
      CAVEMAN_HOME: caveHome,
      ...extra,
    },
  };
}

function writeCrossPlatformBin(dir, name, jsBody) {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, `${name}.impl.cjs`);
  writeFileSync(scriptPath, jsBody, "utf8");
  if (process.platform === "win32") {
    const cmdPath = join(dir, `${name}.cmd`);
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return cmdPath;
  }
  const shPath = join(dir, name);
  writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
  chmodSync(shPath, 0o755);
  return shPath;
}

function runCli(argv, env, stdinData = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    if (stdinData !== undefined) child.stdin.end(stdinData);
    else child.stdin.end();
  });
}

test("shrink-hook handles Antigravity PreToolUse run_command without permission decision", async () => {
  const { root, env } = makeHomeEnv();
  try {
    // Provide a space-free caveman shim on PATH so Windows hosts where
    // process.execPath lives under "Program Files" still have a valid host-shell
    // target for cavemanBinForHostShell().
    const binDir = join(root, "bin");
    writeCrossPlatformBin(
      binDir,
      "caveman",
      `process.argv.splice(1, 0, ${JSON.stringify(cli)}); require(${JSON.stringify(cli)});`,
    );
    const hookEnv = {
      ...env,
      PATH: `${binDir}${delimiter}${env.PATH || ""}`,
    };

    const rewritten = await runCli(
      ["shrink-hook"],
      hookEnv,
      JSON.stringify({
        hookEventName: "PreToolUse",
        toolCall: {
          id: "call_1",
          name: "run_command",
          args: {
            CommandLine: "git status",
            WaitMsBeforeAsync: 5000,
          },
        },
      }),
    );
    assert.equal(rewritten.code, 0, rewritten.stderr);
    const out = JSON.parse(rewritten.stdout);
    assert.equal(out.decision, undefined, "must not override host approval decisions");
    assert.equal(out.hookSpecificOutput, undefined);
    assert.match(out.overwrite.CommandLine, /shrink -- git status$/);

    // Non-eligible commands pass through with empty stdout.
    for (const cmd of ["echo hello", "git status | head", "caveman shrink -- git status"]) {
      const pass = await runCli(
        ["shrink-hook"],
        hookEnv,
        JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd } } }),
      );
      assert.equal(pass.code, 0, pass.stderr);
      assert.equal(pass.stdout, "", `expected pass-through for ${cmd}`);
    }

    // Non-run_command tools pass through untouched.
    const otherTool = await runCli(
      ["shrink-hook"],
      hookEnv,
      JSON.stringify({ toolCall: { name: "view_file", args: { AbsolutePath: "/tmp/x" } } }),
    );
    assert.equal(otherTool.code, 0);
    assert.equal(otherTool.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mem recall-hook handles Antigravity PreInvocation turn gating, dedup, and injectSteps schema", async () => {
  const { root, env } = makeHomeEnv();
  try {
    const binDir = join(root, "bin");
    const fakeMem = writeCrossPlatformBin(
      binDir,
      "cavemem",
      `
      if (process.argv[2] === "recall") {
        process.stdout.write(JSON.stringify({
          hits: [{
            id: "mem_1",
            text: "gainshare billing lives in billing-service",
            score: 0.72,
            tokens_added: 11,
            basis: "inferred",
            recovery_handle: "ccr_xyz"
          }]
        }));
      } else {
        process.stdout.write("{}");
      }
      `,
    );
    const hookEnv = { ...env, CAVEMEM_BIN: fakeMem };

    // invocationNum === 0 injects Antigravity injectSteps systemMessage
    const first = await runCli(
      ["mem", "recall-hook"],
      hookEnv,
      JSON.stringify({
        hookEventName: "PreInvocation",
        conversationId: "conv-abc",
        invocationNum: 0,
        initialNumSteps: 1,
        lastUserInput: "where does gainshare billing live?",
      }),
    );
    assert.equal(first.code, 0, first.stderr);
    const firstOut = JSON.parse(first.stdout);
    assert.equal(firstOut.hookSpecificOutput, undefined);
    assert.ok(Array.isArray(firstOut.injectSteps) && firstOut.injectSteps.length === 1);
    const sysText = firstOut.injectSteps[0].systemMessage.systemMessage;
    assert.match(sysText, /\+11 tokens · basis inferred/);
    assert.match(sysText, /recover: caveman mem recover ccr_xyz/);

    // Duplicate PreInvocation in same turn is suppressed
    const dup = await runCli(
      ["mem", "recall-hook"],
      hookEnv,
      JSON.stringify({
        hookEventName: "PreInvocation",
        conversationId: "conv-abc",
        invocationNum: 0,
        initialNumSteps: 1,
        lastUserInput: "where does gainshare billing live?",
      }),
    );
    assert.equal(dup.code, 0);
    assert.equal(dup.stdout, "");

    // Next turn (new initialNumSteps) injects again
    const nextTurn = await runCli(
      ["mem", "recall-hook"],
      hookEnv,
      JSON.stringify({
        hookEventName: "PreInvocation",
        conversationId: "conv-abc",
        invocationNum: 0,
        initialNumSteps: 4,
        lastUserInput: "where does gainshare billing live?",
      }),
    );
    assert.equal(nextTurn.code, 0);
    assert.ok(JSON.parse(nextTurn.stdout).injectSteps.length === 1);

    // invocationNum > 0 (tool loop step) never re-injects
    const loopStep = await runCli(
      ["mem", "recall-hook"],
      hookEnv,
      JSON.stringify({
        hookEventName: "PreInvocation",
        conversationId: "conv-abc",
        invocationNum: 2,
        initialNumSteps: 7,
        lastUserInput: "next user prompt",
      }),
    );
    assert.equal(loopStep.code, 0);
    assert.equal(loopStep.stdout, "");

    // [plan review] / [plan review due] system prompts skip recall
    for (const reviewInput of ["[plan review] check step", "[plan review due] hand back"]) {
      const rev = await runCli(
        ["mem", "recall-hook"],
        hookEnv,
        JSON.stringify({
          hookEventName: "PreInvocation",
          conversationId: "conv-review",
          invocationNum: 0,
          initialNumSteps: 0,
          lastUserInput: reviewInput,
        }),
      );
      assert.equal(rev.code, 0);
      assert.equal(rev.stdout, "");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooks install/uninstall & mem hook install/uninstall write Antigravity named hook groups without BOM or PowerShell '&'", async () => {
  const { root, home, caveHome, env } = makeHomeEnv();
  try {
    const hooksPath = join(home, ".gemini", "config", "hooks.json");
    mkdirSync(dirname(hooksPath), { recursive: true });
    // Seed with UTF-8 BOM + JSONC comment + existing user hook group
    writeFileSync(
      hooksPath,
      "\uFEFF// user antigravity hooks\n{\n  \"user-lint\": { \"PreToolUse\": [] },\n}\n",
      "utf8",
    );

    const installShrink = await runCli(["hooks", "install", "antigravity"], env);
    assert.equal(installShrink.code, 0, installShrink.stderr);
    const installRecall = await runCli(["mem", "hook", "install", "agy"], env);
    assert.equal(installRecall.code, 0, installRecall.stderr);

    const rawBytes = readFileSync(hooksPath);
    assert.equal(rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf, false, "must write UTF-8 without BOM");
    const parsed = JSON.parse(rawBytes.toString("utf8"));
    assert.deepEqual(parsed["user-lint"], { PreToolUse: [] });

    const shrinkGroup = parsed["caveman-shrink"];
    assert.ok(Array.isArray(shrinkGroup?.PreToolUse) && shrinkGroup.PreToolUse.length === 1);
    assert.equal(shrinkGroup.PreToolUse[0].matcher, "run_command");
    const shrinkCmd = shrinkGroup.PreToolUse[0].hooks[0].command;
    assert.match(shrinkCmd, /shrink-hook$/);
    assert.equal(shrinkCmd.startsWith("& "), false, "Antigravity cmd /c cannot use PowerShell '&' prefix");

    const recallGroup = parsed["caveman-recall"];
    assert.ok(Array.isArray(recallGroup?.PreInvocation) && recallGroup.PreInvocation.length === 1);
    assert.equal(recallGroup.PreInvocation[0].matcher, undefined, "PreInvocation is flat without matcher");
    const recallCmd = recallGroup.PreInvocation[0].command;
    assert.match(recallCmd, /mem recall-hook$/);
    assert.equal(recallCmd.startsWith("& "), false);

    assert.ok(existsSync(join(caveHome, "hooks", "antigravity.json")));
    assert.ok(existsSync(join(caveHome, "recall-hooks", "antigravity.json")));

    // --directive rejects honestly on Antigravity
    const directive = await runCli(["hooks", "install", "--directive", "deferred-tool-loading", "antigravity"], env);
    assert.equal(directive.code, 2);
    assert.match(directive.stderr, /caveman-init --agent antigravity/);

    // Uninstall removes only caveman hook groups and leaves user groups intact
    const uninstallShrink = await runCli(["hooks", "uninstall", "antigravity"], env);
    assert.equal(uninstallShrink.code, 0, uninstallShrink.stderr);
    const uninstallRecall = await runCli(["mem", "hook", "uninstall", "antigravity"], env);
    assert.equal(uninstallRecall.code, 0, uninstallRecall.stderr);

    const after = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.deepEqual(after, { "user-lint": { PreToolUse: [] } });
    assert.equal(existsSync(join(caveHome, "hooks", "antigravity.json")), false);
    assert.equal(existsSync(join(caveHome, "recall-hooks", "antigravity.json")), false);

    // No-target uninstall also cleans up installed Antigravity hooks when PATH has no other agents
    assert.equal((await runCli(["hooks", "install", "antigravity"], env)).code, 0);
    assert.equal((await runCli(["mem", "hook", "install", "antigravity"], env)).code, 0);
    const emptyPathEnv = { ...env, PATH: "" };
    assert.equal((await runCli(["hooks", "uninstall"], emptyPathEnv)).code, 0);
    assert.equal((await runCli(["mem", "hook", "uninstall"], emptyPathEnv)).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(hooksPath, "utf8")), { "user-lint": { PreToolUse: [] } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp install/uninstall antigravity manages ~/.gemini/config/mcp_config.json safely", async () => {
  const { root, home, caveHome, env } = makeHomeEnv();
  try {
    const mcpPath = join(home, ".gemini", "config", "mcp_config.json");
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(
      mcpPath,
      "\uFEFF{\n  // existing server\n  \"mcpServers\": {\n    \"github\": { \"command\": \"npx\", \"args\": [\"-y\", \"github-mcp\"] }\n  }\n}\n",
      "utf8",
    );

    const inst = await runCli(["mcp", "install", "antigravity"], env);
    assert.equal(inst.code, 0, inst.stderr);
    assert.match(inst.stderr, /Antigravity: caveman_retrieve installed/);

    const raw = readFileSync(mcpPath);
    assert.equal(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, false, "must write UTF-8 without BOM");
    const doc = JSON.parse(raw.toString("utf8"));
    assert.deepEqual(doc.mcpServers.github, { command: "npx", args: ["-y", "github-mcp"] });
    assert.ok(doc.mcpServers.caveman && typeof doc.mcpServers.caveman.command === "string");
    assert.ok(existsSync(join(caveHome, "mcp", "antigravity.json")));

    const uninst = await runCli(["mcp", "uninstall", "antigravity"], env);
    assert.equal(uninst.code, 0, uninst.stderr);
    const after = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.deepEqual(after.mcpServers, { github: { command: "npx", args: ["-y", "github-mcp"] } });
    assert.equal(existsSync(join(caveHome, "mcp", "antigravity.json")), false);

    // No-target mcp uninstall cleans up installed Antigravity MCP entry
    assert.equal((await runCli(["mcp", "install", "antigravity"], env)).code, 0);
    assert.equal((await runCli(["mcp", "uninstall"], env)).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers, { github: { command: "npx", args: ["-y", "github-mcp"] } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caveman wrap antigravity and caveman antigravity fail closed with native setup guidance", async () => {
  const { root, env } = makeHomeEnv();
  try {
    for (const argv of [
      ["wrap", "antigravity"],
      ["wrap", "agy"],
      ["antigravity"],
      ["antigravity-ide"],
    ]) {
      const res = await runCli(argv, env);
      assert.equal(res.code, 1, `expected fail-closed exit 1 for ${argv.join(" ")}`);
      assert.match(res.stderr, /does not use an HTTP proxy wrapper/);
      assert.match(res.stderr, /caveman enable antigravity/);
      assert.match(res.stderr, /caveman hooks install antigravity/);
      assert.match(res.stderr, /caveman mcp install antigravity/);
      assert.match(res.stderr, /caveman doctor antigravity/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enable, disable, and doctor antigravity [--fix] detect and repair issues without touching config.json", async () => {
  const { root, home, env } = makeHomeEnv();
  try {
    const configDir = join(home, ".gemini", "config");
    const agyBinDir = join(home, ".gemini", "bin");
    const pluginDir = join(configDir, "plugins", "caveman");
    const pluginHooksDir = join(pluginDir, "hooks");
    const legacyIdeDir = join(home, ".gemini", "antigravity-ide");
    mkdirSync(pluginHooksDir, { recursive: true });
    mkdirSync(legacyIdeDir, { recursive: true });

    // Create a secret config.json (0600) that caveman MUST never read or parse (even invalid JSON).
    const secretConfigPath = join(configDir, "config.json");
    writeFileSync(secretConfigPath, "{ INVALID JSON DO NOT READ CONFIG.JSON !!", { mode: 0o600 });

    // Legacy IDE mcp_config.json without .ide_migration marker triggers warning
    writeFileSync(join(legacyIdeDir, "mcp_config.json"), JSON.stringify({ mcpServers: {} }), "utf8");

    // Stage mock agy CLI off-PATH in ~/.gemini/bin/ with state file tracking plugin enabled status
    const stateFile = join(root, "agy-state.json");
    writeFileSync(stateFile, JSON.stringify({ enabled: false }), "utf8");
    writeCrossPlatformBin(
      agyBinDir,
      "agy",
      `
      const fs = require("node:fs");
      const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
      const args = process.argv.slice(2);
      if (args[0] === "plugin" && args[1] === "list") {
        process.stdout.write(JSON.stringify([{ id: "caveman@local", name: "caveman", enabled: state.enabled }]));
      } else if (args[0] === "plugin" && args[1] === "enable") {
        state.enabled = true;
        fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
      } else if (args[0] === "plugin" && args[1] === "disable") {
        state.enabled = false;
        fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
      }
      `,
    );

    // Stage plugin manifest + broken plugin hooks.json (dead node path)
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "caveman", displayName: "Caveman" }), "utf8");
    const localHookScript = join(pluginHooksDir, "caveman-antigravity.js");
    writeFileSync(localHookScript, "// hook stub\n", "utf8");
    const pluginHooksPath = join(pluginDir, "hooks.json");
    writeFileSync(
      pluginHooksPath,
      JSON.stringify({
        caveman: {
          SessionStart: [{ type: "command", command: `"/dead/missing/node" "${localHookScript}" session-start`, timeout: 10 }],
        },
      }),
      "utf8",
    );

    // 1. Doctor without --fix fails on broken plugin hooks & disabled plugin, warns on off-PATH agy & .ide_migration
    const diag = await runCli(["doctor", "antigravity"], env);
    assert.equal(diag.code, 1, `expected doctor antigravity exit 1; stdout=${diag.stdout}\nstderr=${diag.stderr}`);
    assert.match(diag.stdout, /not on PATH/);
    assert.match(diag.stdout, /plugin hooks\.json broken.*missing executable/i);
    assert.match(diag.stdout, /disabled in agy/i);
    assert.match(diag.stdout, /without \.ide_migration/);
    assert.equal(readFileSync(secretConfigPath, "utf8"), "{ INVALID JSON DO NOT READ CONFIG.JSON !!", "must never modify 0600 config.json");

    // 2. Bare `caveman doctor` (modulesDoctor) surfaces the Antigravity failure while configured
    const bareDoc = await runCli(["doctor"], env);
    assert.equal(bareDoc.code, 1);
    assert.match(bareDoc.stdout, /antigravity plugin hooks\.json broken/);

    // 3. Doctor --fix repairs plugin hooks.json, enables plugin via agy, and installs global hooks + MCP
    const fix = await runCli(["doctor", "antigravity", "--fix"], env);
    assert.equal(fix.code, 0, `expected --fix exit 0; stdout=${fix.stdout}\nstderr=${fix.stderr}`);
    const repairedPluginHooks = JSON.parse(readFileSync(pluginHooksPath, "utf8"));
    const fixedCmd = repairedPluginHooks.caveman.SessionStart[0].command;
    assert.ok(fixedCmd.includes(process.execPath), `expected repaired exe ${process.execPath}, got ${fixedCmd}`);
    assert.ok(fixedCmd.includes("session-start"));
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).enabled, true);

    const globalHooks = JSON.parse(readFileSync(join(configDir, "hooks.json"), "utf8"));
    assert.ok(globalHooks["caveman-shrink"]);
    const mcpCfg = JSON.parse(readFileSync(join(configDir, "mcp_config.json"), "utf8"));
    assert.ok(mcpCfg.mcpServers.caveman);

    // 4. Re-running doctor antigravity passes cleanly once .ide_migration is satisfied and agy is on PATH
    writeFileSync(join(legacyIdeDir, ".ide_migration"), "migrated\n", "utf8");
    const healthyEnv = { ...env, PATH: `${agyBinDir}${delimiter}${env.PATH || ""}` };
    const cleanDoc = await runCli(["doctor", "antigravity"], healthyEnv);
    assert.equal(cleanDoc.code, 0, cleanDoc.stdout + cleanDoc.stderr);
    assert.doesNotMatch(cleanDoc.stdout, /not on PATH/);

    // 5. disable antigravity cleans hooks + MCP + toggles agy plugin disable; enable antigravity restores
    const dis = await runCli(["disable", "antigravity"], healthyEnv);
    assert.equal(dis.code, 0, dis.stderr);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).enabled, false);
    assert.equal(JSON.parse(readFileSync(join(configDir, "hooks.json"), "utf8"))["caveman-shrink"], undefined);
    assert.equal(JSON.parse(readFileSync(join(configDir, "mcp_config.json"), "utf8")).mcpServers.caveman, undefined);

    const en = await runCli(["enable", "antigravity"], healthyEnv);
    assert.equal(en.code, 0, en.stderr);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).enabled, true);
    assert.ok(JSON.parse(readFileSync(join(configDir, "hooks.json"), "utf8"))["caveman-shrink"]);
    assert.ok(JSON.parse(readFileSync(join(configDir, "mcp_config.json"), "utf8")).mcpServers.caveman);
    assert.equal(readFileSync(secretConfigPath, "utf8"), "{ INVALID JSON DO NOT READ CONFIG.JSON !!");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
