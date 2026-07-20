#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path.slice(root.length + 1)} is not valid JSON: ${error.message}`);
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

const settings = readJson(join(root, "settings.json"));
if (settings) {
  const keys = Object.keys(settings).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["packages", "theme"])) {
    fail(`settings.json must contain only "packages" and "theme"; found: ${keys.join(", ")}`);
  }
  if (settings.theme !== "void-agent-tokyo-night") {
    fail(`settings.json theme must be void-agent-tokyo-night; found: ${JSON.stringify(settings.theme)}`);
  }
  if (!Array.isArray(settings.packages)) {
    fail("settings.json packages must be an array");
  } else {
    if (settings.packages.length !== 25) {
      fail(`settings.json must enable 25 reviewed packages; found ${settings.packages.length}`);
    }
    if (new Set(settings.packages).size !== settings.packages.length) {
      fail("settings.json contains duplicate package entries");
    }
    for (const packagePath of settings.packages) {
      if (typeof packagePath !== "string") {
        fail(`package entry is not a string: ${JSON.stringify(packagePath)}`);
        continue;
      }
      if (isAbsolute(packagePath) || !packagePath.startsWith("./configs/pi-agent/packages/")) {
        fail(`package path is not portable and repository-relative: ${packagePath}`);
        continue;
      }
      if (packagePath.includes("_archive") || packagePath.toLowerCase().includes("/archive/")) {
        fail(`active package points into an archive: ${packagePath}`);
      }
      const absolutePackage = resolve(root, packagePath);
      let stat;
      try {
        stat = lstatSync(absolutePackage);
      } catch {
        fail(`configured package does not exist: ${packagePath}`);
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(`configured package is not an ordinary directory: ${packagePath}`);
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
}

const keybindings = readJson(join(root, "keybindings.json"));
if (keybindings) {
  if (keybindings["app.thinking.cycle"] !== "alt+t") {
    fail("keybindings.json must reserve Shift+Tab by mapping app.thinking.cycle to alt+t");
  }
  if (keybindings["app.model.cycleForward"] !== "alt+m") {
    fail("keybindings.json must map app.model.cycleForward to alt+m");
  }
}

function collectSkillFiles(directory, found = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    fail(`cannot read skill directory ${directory.slice(root.length + 1)}: ${error.message}`);
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
if (skillFiles.length !== 38) {
  fail(`expected 38 global SKILL.md files; found ${skillFiles.length}`);
}
for (const skillFile of skillFiles) {
  const prefix = readFileSync(skillFile, "utf8").slice(0, 16 * 1024);
  const frontmatter = prefix.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || !/^name:\s*\S+/m.test(frontmatter)) {
    fail(`${skillFile.slice(root.length + 1)} is missing frontmatter name`);
  }
  const lines = frontmatter?.split(/\r?\n/) ?? [];
  const descriptionIndex = lines.findIndex((line) => line.startsWith("description:"));
  if (descriptionIndex < 0) {
    fail(`${skillFile.slice(root.length + 1)} is missing frontmatter description`);
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
    fail(`${skillFile.slice(root.length + 1)} has an empty frontmatter description`);
  } else if (normalizedDescription.length > 1024) {
    fail(`${skillFile.slice(root.length + 1)} description exceeds 1024 characters (${normalizedDescription.length})`);
  }
}

const expectedDefinitions = ["pi-reviewer.md", "planner.md", "reviewer.md", "scout.md", "worker.md"];
for (const directory of ["subagents", "teams"]) {
  let actual = [];
  try {
    actual = readdirSync(join(root, directory)).filter((name) => name.endsWith(".md")).sort();
  } catch (error) {
    fail(`cannot read ${directory}/: ${error.message}`);
    continue;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expectedDefinitions)) {
    fail(`${directory}/ definitions must be exactly: ${expectedDefinitions.join(", ")}; found: ${actual.join(", ")}`);
  }
  for (const name of actual) {
    const stat = lstatSync(join(root, directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      fail(`${directory}/${name} must be an independent ordinary file`);
    }
  }
}
for (const name of expectedDefinitions) {
  const subagent = readFileSync(join(root, "subagents", name));
  const team = readFileSync(join(root, "teams", name));
  if (!subagent.equals(team)) fail(`subagents/${name} and teams/${name} differ`);
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
for (const requiredRoot of ["codex/", "configs/", "mcp/", "plans/", "workflows/"]) {
  if (!tracked.some((path) => path.startsWith(requiredRoot))) {
    fail(`lowercase shared directory is absent from the tracked clone: ${requiredRoot}`);
  }
}
for (const path of tracked) {
  if (/^(Codex|Configs|MCP|Plans|Workflows)(\/|$)/.test(path)) {
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
  "workflows.json",
]);
for (const path of tracked) {
  if (forbiddenExact.has(path) || /^(sessions|npm|git|bin|tools|tmp)\//.test(path)) {
    fail(`tracked private/runtime path: ${path}`);
  }
  const ignored = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", path]);
  if (ignored.status === 0) fail(`tracked path matches the private/runtime ignore policy: ${path}`);
  else if (ignored.status !== 1) fail(`could not evaluate ignore policy for tracked path: ${path}`);
}
try {
  const linkedEntries = git(["ls-files", "-s"])
    .split("\n")
    .filter((line) => line.startsWith("120000 "));
  if (linkedEntries.length > 0) fail(`tracked symlinks are not allowed:\n${linkedEntries.join("\n")}`);
} catch (error) {
  fail(`cannot inspect tracked file modes: ${error.message}`);
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
  "workflows.json",
  ".claude/probe",
  ".env",
  "private/id_ed25519",
]) {
  const result = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", ignoredPath]);
  if (result.status !== 0) fail(`expected ignored path is not covered: ${ignoredPath}`);
}

notes.push(`${settings?.packages?.length ?? 0} portable package paths`);
notes.push(`${skillFiles.length} global skills`);
notes.push(`${expectedDefinitions.length} synchronized subagent/team definitions`);

if (failures.length > 0) {
  console.error("Global Pi configuration validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Global Pi configuration validation passed (${notes.join(", ")}).`);
}
