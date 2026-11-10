import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piInvocation } from "../../../tests/runtime.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUCCESS_MARKER = "pi-tool-monitor assertions passed";
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "pi-tool-monitor-"));
const invocation = piInvocation(["--mode", "rpc", "--offline", "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-themes", "--no-prompt-templates", "--extension", "./test/tool-monitor.test.ts"]);
const result = spawnSync(
	invocation.command,
	invocation.args,
	{
		cwd: packageDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: scratch, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
		timeout: 30_000,
		encoding: "utf8",
		input: '{"type":"get_state"}\n',
	},
);

rmSync(scratch, { recursive: true, force: true });
if (result.error) throw result.error;
const output = `${result.stdout}\n${result.stderr}`;
if (result.status !== 0 || !output.includes(SUCCESS_MARKER)) {
	process.stderr.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exit(1);
}

console.log("pi-tool-monitor tests passed");
