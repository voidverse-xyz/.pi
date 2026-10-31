import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { piInvocation } from "./runtime.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("all configured packages register together in isolated offline Pi", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-package-load-"));
  try {
    const agentDir = join(temporary, "agent");
    mkdirSync(agentDir);
    const configuration = JSON.parse(readFileSync(join(root, "agent/settings.json"), "utf8"));
    const packages = configuration.packages.map((path) => resolve(root, "agent", path));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages, theme: configuration.theme }));
    const output = join(temporary, "tools.json");
    const probe = join(temporary, "probe.ts");
    writeFileSync(probe, `import {writeFileSync} from "node:fs";\nexport default function(pi) { pi.on("session_start", () => writeFileSync(${JSON.stringify(output)}, JSON.stringify(pi.getAllTools().map(t => t.name)))); }`);
    const invocation = piInvocation(["--mode", "rpc", "--offline", "--no-session", "--no-mcp", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-approve", "-e", probe]);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: temporary, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      input: '{"id":"commands","type":"get_commands"}\n{"id":"state","type":"get_state"}\n',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const records = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(records.some((record) => record.type === "extension_error" || record.success === false), false, result.stdout);
    assert.doesNotMatch(result.stderr, /failed to load|extension error|invalid theme/i);
    const commands = records.find((record) => record.id === "commands")?.data?.commands ?? [];
    for (const name of ["plan", "safety", "subagents", "teams", "procedures", "swarm", "handoff", "prune", "tools"]) {
      assert.ok(commands.some((command) => command.name === name), `missing command ${name}`);
    }
    for (const name of ["matrix", "working-animation"]) {
      assert.equal(commands.some((command) => command.name === name), false, `retired command ${name} must stay absent`);
    }
    const tools = JSON.parse(readFileSync(output, "utf8"));
    for (const name of ["subagent_spawn", "team_spawn", "procedure", "todo_write", "web_search", "image_generation", "ask_user", "show_files", "swarm_start"]) {
      assert.ok(tools.includes(name), `missing tool ${name}`);
    }
    console.log(`${packages.length} configured packages loaded without extension errors.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
