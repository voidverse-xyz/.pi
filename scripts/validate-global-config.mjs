#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

const EXPECTED_PACKAGE_COUNT = 28;
const EXPECTED_SKILL_COUNT = 33;
const EXPECTED_THEME = "void-agent-tokyo-night";
const ROOT_PACKAGE_PREFIX = "./configs/pi-agent/packages/";
const AGENT_PACKAGE_PREFIX = "./configs/pi-agent/packages/";

function fail(message) {
  failures.push(message);
}

function rel(path) {
  return path.slice(root.length + 1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${rel(path)} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function git(args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validatePackageList(settings, settingsRelPath, baseDir, packagePrefix, checkPackageFiles = true) {
  if (!Array.isArray(settings.packages)) {
    fail(`${settingsRelPath} packages must be an array`);
    return;
  }
  if (settings.packages.length !== EXPECTED_PACKAGE_COUNT) {
    fail(`${settingsRelPath} must enable ${EXPECTED_PACKAGE_COUNT} reviewed packages; found ${settings.packages.length}`);
  }
  if (new Set(settings.packages).size !== settings.packages.length) {
    fail(`${settingsRelPath} contains duplicate package entries`);
  }
  for (const packagePath of settings.packages) {
    if (typeof packagePath !== "string") {
      fail(`${settingsRelPath} package entry is not a string: ${JSON.stringify(packagePath)}`);
      continue;
    }
    if (isAbsolute(packagePath) || !packagePath.startsWith(packagePrefix)) {
      fail(`${settingsRelPath} package path is not portable and agent-dir-relative: ${packagePath}`);
      continue;
    }
    if (packagePath.includes("_archive") || packagePath.toLowerCase().includes("/archive/")) {
      fail(`${settingsRelPath} active package points into an archive: ${packagePath}`);
    }
    if (!checkPackageFiles) continue;
    const absolutePackage = resolve(baseDir, packagePath);
    let stat;
    try {
      stat = lstatSync(absolutePackage);
    } catch {
      fail(`${settingsRelPath} configured package does not exist: ${packagePath}`);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`${settingsRelPath} configured package is not an ordinary directory: ${packagePath}`);
      continue;
    }
    const manifest = readJson(join(absolutePackage, "package.json"));
    if (!manifest) continue;
    if (!Array.isArray(manifest.keywords) || !manifest.keywords.includes("pi-package")) {
      fail(`${packagePath}/package.json is missing the pi-package keyword`);
    }
    for (const resourceType of ["extensions", "skills", "prompts", "themes"]) {
      for (const resourcePath of manifest.pi?.[resourceType] ?? []) {
        try {
          lstatSync(resolve(absolutePackage, resourcePath));
        } catch {
          fail(`${packagePath} declares missing ${resourceType} resource: ${resourcePath}`);
        }
      }
    }
  }
}

function validateSettingsFile({ relativePath, baseDir, allowedKeys, packagePrefix, expectedSkills, checkPackageFiles = true }) {
  const settings = readJson(join(root, relativePath));
  if (!settings) return undefined;
  const keys = Object.keys(settings).sort();
  if (!sameJson(keys, [...allowedKeys].sort())) {
    fail(`${relativePath} must contain only ${allowedKeys.map((key) => JSON.stringify(key)).join(", ")}; found: ${keys.join(", ")}`);
  }
  if (settings.theme !== EXPECTED_THEME) {
    fail(`${relativePath} theme must be ${EXPECTED_THEME}; found: ${JSON.stringify(settings.theme)}`);
  }
  if (expectedSkills !== undefined && !sameJson(settings.skills, expectedSkills)) {
    fail(`${relativePath} skills must be ${JSON.stringify(expectedSkills)}; found: ${JSON.stringify(settings.skills)}`);
  }
  validatePackageList(settings, relativePath, baseDir, packagePrefix, checkPackageFiles);
  return settings;
}

const rootSettings = validateSettingsFile({
  relativePath: "settings.json",
  baseDir: root,
  allowedKeys: ["packages", "theme"],
  packagePrefix: ROOT_PACKAGE_PREFIX,
});
// The agent/ shim is active when the repository is checked out one level above
// Pi's effective agent dir (repo at ~/.pi, live config at ~/.pi/agent). When the
// repository is checked out directly as ~/.pi/agent, these nested shims are
// dormant; validate their JSON shape but not the intentionally out-of-layout
// symlink targets.
const agentShimActive = existsSync(join(root, "agent", "configs", "pi-agent", "packages"));
const agentSettings = validateSettingsFile({
  relativePath: "agent/settings.json",
  baseDir: join(root, "agent"),
  allowedKeys: ["packages", "skills", "theme"],
  packagePrefix: AGENT_PACKAGE_PREFIX,
  expectedSkills: ["./skills"],
  checkPackageFiles: agentShimActive,
});
if (rootSettings && agentSettings && !sameJson(rootSettings.packages, agentSettings.packages)) {
  fail("agent/settings.json packages must mirror root settings.json packages");
}

function validateKeybindings(relativePath) {
  const keybindings = readJson(join(root, relativePath));
  if (!keybindings) return undefined;
  if (keybindings["app.thinking.cycle"] !== "alt+t") {
    fail(`${relativePath} must reserve Shift+Tab by mapping app.thinking.cycle to alt+t`);
  }
  if (keybindings["app.model.cycleForward"] !== "alt+m") {
    fail(`${relativePath} must map app.model.cycleForward to alt+m`);
  }
  return keybindings;
}

const rootKeybindings = validateKeybindings("keybindings.json");
const agentKeybindings = validateKeybindings("agent/keybindings.json");
if (rootKeybindings && agentKeybindings && !sameJson(rootKeybindings, agentKeybindings)) {
  fail("agent/keybindings.json must mirror root keybindings.json");
}

function collectSkillFiles(directory, found = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    fail(`cannot read skill directory ${rel(directory)}: ${error.message}`);
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectSkillFiles(path, found);
    else if (entry.isFile() && entry.name === "SKILL.md") found.push(path);
  }
  return found;
}

const skillFiles = collectSkillFiles(join(root, "skills"));
if (skillFiles.length !== EXPECTED_SKILL_COUNT) {
  fail(`expected ${EXPECTED_SKILL_COUNT} global SKILL.md files; found ${skillFiles.length}`);
}
for (const skillFile of skillFiles) {
  const prefix = readFileSync(skillFile, "utf8").slice(0, 16 * 1024);
  const frontmatter = prefix.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || !/^name:\s*\S+/m.test(frontmatter)) {
    fail(`${rel(skillFile)} is missing frontmatter name`);
  }
  const lines = frontmatter?.split(/\r?\n/) ?? [];
  const descriptionIndex = lines.findIndex((line) => line.startsWith("description:"));
  if (descriptionIndex < 0) {
    fail(`${rel(skillFile)} is missing frontmatter description`);
    continue;
  }
  const first = lines[descriptionIndex].slice("description:".length).trim();
  let normalizedDescription = first;
  if (["|", "|-", ">", ">-"].includes(first)) {
    const body = [];
    for (const line of lines.slice(descriptionIndex + 1)) {
      if (!/^\s+/.test(line)) break;
      body.push(line.trim());
    }
    normalizedDescription = body.join("\n");
  }
  if (!normalizedDescription.trim()) {
    fail(`${rel(skillFile)} has an empty frontmatter description`);
  } else if (normalizedDescription.length > 1024) {
    fail(`${rel(skillFile)} description exceeds 1024 characters (${normalizedDescription.length})`);
  }
}

const expectedDefinitions = ["issue-coordinator.md", "pi-reviewer.md", "planner.md", "reviewer.md", "scout.md", "worker.md"];
let actualDefinitions = [];
try {
  actualDefinitions = readdirSync(join(root, "subagents")).filter((name) => name.endsWith(".md")).sort();
} catch (error) {
  fail(`cannot read subagents/: ${error.message}`);
}
if (!sameJson(actualDefinitions, expectedDefinitions)) {
  fail(`subagents/ definitions must be exactly: ${expectedDefinitions.join(", ")}; found: ${actualDefinitions.join(", ")}`);
}
for (const name of actualDefinitions) {
  const stat = lstatSync(join(root, "subagents", name));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(`subagents/${name} must be an independent ordinary file`);
  }
}
if (existsSync(join(root, "teams"))) {
  fail("legacy teams/ definition directory must be absent; Pi Teams uses subagents/");
}

let tracked = [];
try {
  tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  if (untracked.length > 0) {
    fail(`nonignored files are not tracked and would be absent from a clone:\n${untracked.join("\n")}`);
  }
} catch (error) {
  fail(`cannot inspect tracked files: ${error.message}`);
}
for (const requiredRoot of ["codex/", "configs/", "mcp/", "plans/", "procedures/"]) {
  if (!tracked.some((path) => path.startsWith(requiredRoot))) {
    fail(`lowercase shared directory is absent from the tracked clone: ${requiredRoot}`);
  }
}
for (const requiredAgentEntry of [
  "agent/AGENTS.md",
  "agent/configs",
  "agent/keybindings.json",
  "agent/settings.json",
  "agent/skills",
  "agent/subagents",
  "agent/procedures",
]) {
  if (!tracked.includes(requiredAgentEntry)) {
    fail(`tracked agent-dir compatibility entry is missing: ${requiredAgentEntry}`);
  }
}
for (const path of tracked) {
  if (/^(Codex|Configs|MCP|Plans|Procedures)(\/|$)/.test(path)) {
    fail(`tracked repository-owned path has obsolete capitalized directory casing: ${path}`);
  }
  if (/^(codex\/(Configs|Plugins)|configs\/(PiAgent|Podman|Subagent-Docs))(\/|$)/.test(path)) {
    fail(`tracked nested repository-owned path has obsolete capitalized directory casing: ${path}`);
  }
}

const forbiddenExact = new Set([
  "auth.json",
  "oauth.json",
  "models.json",
  "models-store.json",
  "trust.json",
  "safety.json",
  "safety-audit.jsonl",
  "subagents.json",
  "teams.json",
  "procedures.json",
]);
const forbiddenRuntimeDirs = /^(sessions|npm|git|bin|tools|tmp)\//;
function isPrivateRuntimePath(path) {
  if (forbiddenExact.has(path) || forbiddenRuntimeDirs.test(path)) return true;
  if (!path.startsWith("agent/")) return false;
  const nested = path.slice("agent/".length);
  return forbiddenExact.has(nested) || forbiddenRuntimeDirs.test(nested);
}
for (const path of tracked) {
  if (isPrivateRuntimePath(path)) {
    fail(`tracked private/runtime path: ${path}`);
  }
  const ignored = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", path]);
  if (ignored.status === 0) fail(`tracked path matches the private/runtime ignore policy: ${path}`);
  else if (ignored.status !== 1) fail(`could not evaluate ignore policy for tracked path: ${path}`);
}

const allowedSymlinks = new Map([
  ["agent/AGENTS.md", "../AGENTS.md"],
  ["agent/configs", "../configs"],
  ["agent/skills", "../skills"],
  ["agent/subagents", "../subagents"],
  ["agent/procedures", "../procedures"],
]);
try {
  const linkedEntries = git(["ls-files", "-s"])
    .split("\n")
    .filter((line) => line.startsWith("120000 "));
  for (const entry of linkedEntries) {
    const path = entry.split(/\s+/).at(-1);
    const expectedTarget = allowedSymlinks.get(path);
    if (!expectedTarget) {
      fail(`tracked symlink is not an approved agent-dir shim: ${entry}`);
      continue;
    }
    const actualTarget = readlinkSync(join(root, path));
    if (actualTarget !== expectedTarget) {
      fail(`${path} must point to ${expectedTarget}; found ${actualTarget}`);
    }
  }
  for (const path of allowedSymlinks.keys()) {
    if (tracked.includes(path)) {
      const mode = git(["ls-files", "-s", "--", path]).trim().split(/\s+/)[0];
      if (mode !== "120000") fail(`${path} must be a relative symlink agent-dir shim`);
    }
  }
} catch (error) {
  fail(`cannot inspect tracked symlinks: ${error.message}`);
}

for (const ignoredPath of [
  "auth.json",
  "oauth.json",
  "models.json",
  "sessions/probe.jsonl",
  "trust.json",
  "models-store.json",
  "npm/probe",
  "git/probe",
  "bin/probe",
  "tmp/pi-global-config-migration/probe",
  "safety.json",
  "safety-audit.jsonl",
  "subagents.json",
  "teams.json",
  "procedures.json",
  "agent/auth.json",
  "agent/oauth.json",
  "agent/models.json",
  "agent/sessions/probe.jsonl",
  "agent/trust.json",
  "agent/models-store.json",
  "agent/npm/probe",
  "agent/git/probe",
  "agent/bin/probe",
  "agent/tmp/probe",
  "agent/safety.json",
  "agent/safety-audit.jsonl",
  "agent/subagents.json",
  "agent/teams.json",
  "agent/procedures.json",
  ".claude/probe",
  ".env",
  "private/id_ed25519",
]) {
  const result = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", ignoredPath]);
  if (result.status !== 0) fail(`expected ignored path is not covered: ${ignoredPath}`);
}

notes.push(`${rootSettings?.packages?.length ?? 0} root package paths`);
notes.push(`${agentSettings?.packages?.length ?? 0} agent-dir package paths`);
notes.push(`${skillFiles.length} global skills`);
notes.push(`${expectedDefinitions.length} shared subagent/team definitions`);

if (failures.length > 0) {
  console.error("Global Pi configuration validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Global Pi configuration validation passed (${notes.join(", ")}).`);
}
