import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { findPiPackage, piInvocation } from "./runtime.mjs";
import { dirname, join, relative, resolve } from "node:path";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const integration = process.argv.includes("--integration");
if (process.argv.slice(2).some((arg) => arg !== "--integration")) throw new Error("Usage: node run.mjs [--integration]");
const sdk = findPiPackage();
const logs = mkdtempSync(join(tmpdir(), "pi-extension-tests-"));
const agentDir = join(logs, "agent");
mkdirSync(agentDir);
const environment = { ...process.env, PI_SDK_DIR: sdk, PI_BIN: piInvocation([], sdk).args[0],
  PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
const packages = JSON.parse(readFileSync(join(root, "agent/settings.json"), "utf8")).packages;
const files = [];
for (const configured of packages) {
  const directory = resolve(root, "agent", configured);
  for (const file of walk(directory)) {
    if (/\.test\.(?:ts|mjs)$/.test(file)) {
      files.push(file.endsWith("pi-tool-monitor/test/tool-monitor.test.ts") ? join(directory, "test/run.mjs") : file);
    } else if (integration && /[\\/]test[\\/]e2e[\\/](?:phase\d[^/\\]*|loadcheck|lifecycle-runtime|wake-policy)\.mjs$/.test(file)) {
      files.push(file);
    }
  }
}
files.push(...["runtime.test.mjs", "managed-runtime.test.mjs", "standalone-invocation.test.mjs", "shared-resources.test.mjs", "fork-context-runtime.test.mjs", "portable-extensions.test.mjs"].map((name) => join(root, "tests", name)));
const results = [];
for (const [index, file] of [...new Set(files)].sort().entries()) {
  const log = join(logs, `${String(index).padStart(3, "0")}.log`);
  const code = await execute(file, log);
  const path = relative(root, file);
  results.push({ path, code, log });
  console.log(`${code === 0 ? "PASS" : "FAIL"} ${path}`);
  if (code !== 0) console.error(readFileSync(log, "utf8").split("\n").slice(-25).join("\n"));
}
writeFileSync(join(logs, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((result) => result.code !== 0).length;
console.log(`${results.length - failed}/${results.length} test files passed. Logs: ${logs}`);
process.exitCode = failed ? 1 : 0;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".git", "__pycache__"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

function execute(file, log) {
  return new Promise((resolveResult) => {
    const descriptor = openSync(log, "w", 0o600);
    const child = spawn(process.execPath, ["--import", join(root, "tests/register.mjs"), file], {
      cwd: root, env: environment, stdio: ["ignore", descriptor, descriptor], detached: process.platform !== "win32",
    });
    closeSync(descriptor);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* The child may have exited before the timer fired. */ }
    }, 90_000);
    child.once("error", (error) => { clearTimeout(timer); console.error(error.message); resolveResult(1); });
    child.once("close", (code) => { clearTimeout(timer); resolveResult(timedOut ? 124 : code ?? 1); });
  });
}
