import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUCCESS_MARKER = "pi-tool-monitor assertions passed";
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
	"pi",
	["--mode", "rpc", "--no-session", "--extension", "./test/tool-monitor.test.ts"],
	{
		cwd: packageDir,
		encoding: "utf8",
		input: '{"type":"get_state"}\n',
	},
);

if (result.error) throw result.error;
if (result.status !== 0 || !result.stdout.includes(SUCCESS_MARKER)) {
	process.stderr.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exit(1);
}

console.log("pi-tool-monitor tests passed");
