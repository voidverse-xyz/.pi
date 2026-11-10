import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Pure Python helper checks run on both platforms; PTY execution remains POSIX-only.
test("fullscreen packet helper reconstructs diff cells and rejects incomplete or stale agreements", t => {
	const candidates = process.env.SWARM_TEST_PYTHON ? [process.env.SWARM_TEST_PYTHON]
		: process.platform === "win32" ? ["python3.10", "python3", "python"] : ["python3"];
	const executable = candidates.find(command => {
		const version = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000 });
		return version.status === 0 && /Python 3\./.test(version.stdout + version.stderr);
	});
	if (!executable) { t.skip("Python3 unavailable for pure terminal helper checks"); return; }
	const result = spawnSync(executable, ["-B", fileURLToPath(new URL("./terminal/packet_test.py", import.meta.url))], {
		encoding: "utf8", timeout: 30000,
	});
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stderr, /Ran [1-9][0-9]* tests/);
});
