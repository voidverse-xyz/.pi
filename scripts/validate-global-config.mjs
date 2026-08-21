#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

const EXPECTED_PACKAGE_COUNT = 31;
const EXPECTED_SKILL_COUNT = 31;
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

const expectedDefinitions = ["planner.md", "reviewer.md", "scout.md", "worker.md"];
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
const expectedRoleDefinitions = new Map([
  ["worker.md", { model: "openai-codex/gpt-5.6-sol", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] }],
  ["reviewer.md", { model: "openai-codex/gpt-5.6-terra", tools: ["read", "bash", "grep", "find", "ls"] }],
]);
for (const [name, expected] of expectedRoleDefinitions) {
  const content = readFileSync(join(root, "subagents", name), "utf8");
  const actualModel = content.match(/^model:\s*(\S+)\s*$/m)?.[1];
  if (actualModel !== expected.model) {
    fail(`subagents/${name} model must be ${expected.model}; found: ${actualModel ?? "none"}`);
  }
  const actualTools = content.match(/^tools:\s*\[([^\]]*)\]\s*$/m)?.[1].split(",").map((tool) => tool.trim());
  if (!sameJson(actualTools, expected.tools)) {
    fail(`subagents/${name} tools must be ${expected.tools.join(", ")}; found: ${(actualTools ?? []).join(", ")}`);
  }
  if (!/^peers:\s*false\s*$/m.test(content)) {
    fail(`subagents/${name} must route coordination through the main agent`);
  }
}
const issueReviewerDefinition = readFileSync(join(root, "subagents", "reviewer.md"), "utf8");
for (const requiredText of ["## Decision", "completed | waiting | blocked", "## Question / blocker", "not-completed"]) {
  if (!issueReviewerDefinition.includes(requiredText)) {
    fail(`subagents/reviewer.md is missing continuation guidance: ${requiredText}`);
  }
}
const issueMaintenanceEvals = readJson(join(root, "skills", "github-issue-maintenance", "evals", "evals.json"));
if (issueMaintenanceEvals?.skill_name !== "github-issue-maintenance") {
  fail("github-issue-maintenance evals must name the skill");
}
const issueMaintenanceEvalItems = issueMaintenanceEvals?.evals;
if (!Array.isArray(issueMaintenanceEvalItems)) {
  fail("github-issue-maintenance evals must be an array");
} else {
  const expectedEvalIds = Array.from({ length: 18 }, (_, index) => index + 1);
  const actualEvalIds = issueMaintenanceEvalItems.map((item) => item?.id);
  if (!sameJson(actualEvalIds, expectedEvalIds)) {
    fail(`github-issue-maintenance eval IDs must be ${expectedEvalIds.join(", ")}`);
  }
  for (const item of issueMaintenanceEvalItems) {
    if (!Number.isInteger(item?.id)) fail("github-issue-maintenance eval id must be an integer");
    if (typeof item?.prompt !== "string" || !item.prompt.trim()) fail(`github-issue-maintenance eval ${item?.id ?? "unknown"} needs a prompt`);
    if (typeof item?.expected_output !== "string" || !item.expected_output.trim()) {
      fail(`github-issue-maintenance eval ${item?.id ?? "unknown"} needs expected_output`);
    }
  }
}
const issueMaintenanceSkill = readFileSync(join(root, "skills", "github-issue-maintenance", "SKILL.md"), "utf8");
for (const requiredText of [
  "Do not create an `issue-maintainer` subagent",
  "within the current owning main Pi session",
  "subagent_spawn",
  "subagent_send",
  "subagent_await",
  "subagent_retire",
  "ownerScopeId",
  "<issue-team-id>",
  "whatever model the user selected",
  "automatic retirement after verified issue closure",
  "Never reuse a retired epoch ID",
  "canonical base-10 `1..9999999999`",
  "canonical base-10 `0..9999999999`",
  "repository ID is at most 226 characters",
  "issue-team ID at most 250 characters",
  "Establish specialists only after the main agent owns a durable claim",
  "Reuse the same fix-issue pair across every pass",
  "later verified reopen is the next epoch's start delimiter",
  "partial-retirement",
  "do not establish any next-epoch pair",
  "Review cannot be bypassed",
  "commits, pushes, and PR publication must each be explicit",
  "never in public GitHub text",
  "status: \"error\"",
  "status: \"retired\"",
]) {
  if (!issueMaintenanceSkill.includes(requiredText)) {
    fail(`github-issue-maintenance is missing required orchestration guidance: ${requiredText}`);
  }
}
const issueMaintenanceNote = readFileSync(join(root, "configs", "pi-agent", "docs", "agents", "notes", "pi-agent", "main-agent-issue-maintenance", "main-agent-issue-maintenance.md"), "utf8");
const issueMaintenanceEvalText = JSON.stringify(issueMaintenanceEvals);
for (const [source, content] of [["skill", issueMaintenanceSkill], ["note", issueMaintenanceNote], ["evals", issueMaintenanceEvalText]]) {
  if (content.includes("gpt-5.3-codex-spark")) {
    fail(`github-issue-maintenance ${source} must not pin or recommend a main-agent model`);
  }
}
const modelsSection = issueMaintenanceSkill.match(/## Models\n\n([\s\S]*?)\n\n## Required inputs and authorization/)?.[1];
const specialistModelsMarker = "The specialist definitions pin their own models:";
const expectedMainModelPolicy = "The main agent uses whatever model the user selected for the current Pi session. This skill does not check, recommend, pin, or switch the main model.";
const mainModelPolicy = modelsSection?.split(specialistModelsMarker)[0].trim();
if (mainModelPolicy !== expectedMainModelPolicy) {
  fail("github-issue-maintenance main-model policy must be exactly model-neutral");
}
const mainModelRow = issueMaintenanceNote.match(/^\| Main coordinator \| ([^|]+) \|$/m)?.[1].trim();
if (mainModelRow !== "Whatever model the user selected for the active Pi session." || mainModelRow.includes("/")) {
  fail("main-agent issue maintenance note must leave the main model user-selected");
}
const expectedModelEval = "Uses whatever model the user selected for the main Pi session without checking or recommending one; worker pins openai-codex/gpt-5.6-sol and reviewer pins openai-codex/gpt-5.6-terra.";
if (issueMaintenanceEvalItems?.find((item) => item?.id === 10)?.expected_output !== expectedModelEval) {
  fail("github-issue-maintenance model eval must enforce a model-neutral main agent");
}
const criticalEvalClauses = new Map([
  [1, ["active main agent", "only for a durably claimed fix-issue epoch"]],
  [3, ["does not create, wake, or reserve worker/reviewer addresses"]],
  [4, ["-i<issue>-e<epoch>", "never reuses a retired epoch ID"]],
  [5, ["repository, issue, epoch, team ID, addresses, and ownerScopeId"]],
  [6, ["Refuses review bypass", "separate worker assignment"]],
  [7, ["226-character repository ID", "250-character issue-team ID", "canonical decimal bounds"]],
  [8, ["without a durable claim", "creates no issue worker/reviewer pair"]],
  [9, ["excludes local paths", "scope/team/session identifiers"]],
  [11, ["different owning main session", "stops rather than adopting"]],
  [12, ["changed edit time or body hash", "never promotes the rejected claim"]],
  [13, ["no publication or automatic replacement", "does not claim the issue team is safe to retire"]],
  [14, ["old anchor as consumed", "new {to, anchorId} target"]],
  [15, ["Reuses the exact worker and reviewer", "until verified closure"]],
  [16, ["later reopen starts epoch 1", "retires the old pair", "fresh non-reused epoch-1 pair"]],
  [17, ["canonical base-10 1..9999999999", "canonical base-10 0..9999999999"]],
  [18, ["partial-retirement", "does not create the epoch-1 pair", "both old addresses are verified retired and absent"]],
]);
for (const [id, clauses] of criticalEvalClauses) {
  const output = issueMaintenanceEvalItems?.find((item) => item?.id === id)?.expected_output ?? "";
  for (const clause of clauses) {
    if (!output.includes(clause)) fail(`github-issue-maintenance eval ${id} is missing required clause: ${clause}`);
  }
}
for (const requiredText of [
  "<repo-id>-i<issue-number>-e<epoch-index>",
  "Whatever model the user selected",
  "canonical base-10 `1..9999999999`",
  "canonical base-10 `0..9999999999`",
  "repository ID is at most 226 characters",
  "issue-team ID at most 250 characters",
  "close and reopen both occurred between passes",
  "partial-retirement",
  "creates no next-epoch pair",
  "fresh pair",
]) {
  if (!issueMaintenanceNote.includes(requiredText)) {
    fail(`main-agent issue maintenance note is missing: ${requiredText}`);
  }
}
const delegatedReviewPaths = [
  join(root, "procedures", "reviews", "delegated-review-results", "delegated-review-results.md"),
  join(root, "configs", "pi-agent", "docs", "agents", "procedures", "reviews", "delegated-review-results", "delegated-review-results.md"),
];
const delegatedReviewProcedures = delegatedReviewPaths.map((path) => readFileSync(path, "utf8"));
if (delegatedReviewProcedures[0] !== delegatedReviewProcedures[1]) {
  fail("delegated-review-results procedure copies must stay synchronized");
}
for (const obsoleteText of ["waitFor:", "subagent_collect", "`attention`"]) {
  if (delegatedReviewProcedures[0].includes(obsoleteText)) {
    fail(`delegated-review-results uses obsolete Pi Subagents guidance: ${obsoleteText}`);
  }
}
for (const requiredText of ["targets:", "anchorId:", "completed", "error", "retired", "timeout", "new envelope ID"]) {
  if (!delegatedReviewProcedures[0].includes(requiredText)) {
    fail(`delegated-review-results is missing current lifecycle guidance: ${requiredText}`);
  }
}
const currentSubagentDocs = [
  join(root, "configs", "subagent-docs", "03-tool-surface.md"),
  join(root, "configs", "pi-agent", "packages", "pi-subagents", "README.md"),
  join(root, "configs", "pi-agent", "docs", "agents", "notes", "architecture", "session-scoped-subagents-implementation", "session-scoped-subagents-implementation.md"),
  join(root, "configs", "pi-agent", "docs", "agents", "plans", "pi-agent", "subagent-session-ownership-and-result-delivery", "subagent-session-ownership-and-result-delivery.md"),
  join(root, "configs", "pi-agent", "docs", "agents", "plans", "pi-agent", "pi-subagents", "pi-subagents.md"),
];
for (const docPath of currentSubagentDocs) {
  const content = readFileSync(docPath, "utf8");
  for (const obsoleteText of ["waitFor:", "subagent_collect", "status:\"attention\"", "completed: [...]", "adopt-legacy", "pi-agents"]) {
    if (content.includes(obsoleteText)) {
      fail(`${rel(docPath)} uses obsolete Pi Subagents guidance: ${obsoleteText}`);
    }
  }
}
const activeToolSurface = readFileSync(currentSubagentDocs[0], "utf8");
for (const requiredText of ["ownerScopeId", "outcomes", "completed", "error", "retired", "new envelope ID"]) {
  if (!activeToolSurface.includes(requiredText)) {
    fail(`current Pi Subagents tool surface is missing: ${requiredText}`);
  }
}
const currentSubagentPlan = readFileSync(currentSubagentDocs[4], "utf8");
for (const requiredText of [
  "payload.terminalAnchors",
  "drained-turn snapshot",
  "all and only its stamped targets",
  "Pre-migration final reports without the list",
  "legacy unscoped error",
  "`completed` or `error`",
  "`retired`",
]) {
  if (!currentSubagentPlan.includes(requiredText)) {
    fail(`current Pi Subagents plan is missing exact-anchor guidance: ${requiredText}`);
  }
}
if (currentSubagentPlan.includes("correlationId === anchorId && final === true")) {
  fail("current Pi Subagents plan uses the retired correlation-only await matcher");
}
const historicalSubagentDocs = [
  join(root, "configs", "subagent-docs", "00-design-log.md"),
  join(root, "configs", "subagent-docs", "01-power-matrix.md"),
  join(root, "configs", "subagent-docs", "02-envelope-contract.md"),
  join(root, "configs", "subagent-docs", "04-type-schema.md"),
  join(root, "configs", "subagent-docs", "05-tui-spec.md"),
  join(root, "configs", "subagent-docs", "06-architecture.md"),
  join(root, "configs", "subagent-docs", "pi-agents-historical-implementation.html"),
  join(root, "configs", "pi-agent", "docs", "agents", "plans", "architecture", "session-scoped-subagents-and-reliable-results", "session-scoped-subagents-and-reliable-results.md"),
  join(root, "configs", "pi-agent", "docs", "agents", "notes", "architecture", "session-scoped-subagents-impact", "session-scoped-subagents-impact.md"),
];
for (const docPath of historicalSubagentDocs) {
  if (!readFileSync(docPath, "utf8").slice(0, 600).toLowerCase().includes("superseded")) {
    fail(`${rel(docPath)} must be marked as superseded historical guidance`);
  }
}
const subagentCoreSource = readFileSync(join(root, "configs", "pi-agent", "packages", "pi-subagents", "extensions", "subagents", "core.ts"), "utf8");
const subagentToolSource = readFileSync(join(root, "configs", "pi-agent", "packages", "pi-subagents", "extensions", "subagents", "tools", "main-agent.ts"), "utf8");
const subagentRuntimeSource = readFileSync(join(root, "configs", "pi-agent", "packages", "pi-subagents", "extensions", "subagents", "runtime", "in-process.ts"), "utf8");
const subagentAwaitTest = readFileSync(join(root, "configs", "pi-agent", "packages", "pi-subagents", "test", "e2e", "phase4-await.mjs"), "utf8");
const subagentResumeTest = readFileSync(join(root, "configs", "pi-agent", "packages", "pi-subagents", "test", "e2e", "phase7-resume.mjs"), "utf8");
if (!subagentCoreSource.includes("ownerScopeId") || !subagentCoreSource.includes("createHash(\"sha256\")")) {
  fail("pi-subagents core must derive an opaque ownerScopeId");
}
if (!subagentToolSource.includes("ownerScopeId: core.ownerScopeId")) {
  fail("subagent_status must return ownerScopeId");
}
if (!subagentResumeTest.includes("owner scope fingerprint survives resume") || !subagentResumeTest.includes("createStatusTool")) {
  fail("pi-subagents resume tests must cover ownerScopeId continuity and status exposure");
}
if (!subagentRuntimeSource.includes('terminal.kind === "legacy-unscoped-error" || terminal.anchors.includes(target.anchorId)')) {
  fail("pi-subagents await must distinguish legacy unscoped errors from modern empty snapshots");
}
if (!subagentAwaitTest.includes("explicit empty error snapshot resolves nothing")) {
  fail("pi-subagents await tests must cover modern empty and legacy unscoped errors");
}
if (existsSync(join(root, "configs", "subagent-docs", "pi-agents-current-implementation.html"))) {
  fail("obsolete current-implementation HTML name must not remain");
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
