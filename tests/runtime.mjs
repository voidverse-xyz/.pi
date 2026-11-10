import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

export function findPiPackage({ env = process.env, home = homedir() } = {}) {
  if (env.PI_SDK_DIR) return validatePiPackage(resolve(env.PI_SDK_DIR));
  const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  for (const install of [env.PI_MANAGED_INSTALL_ROOT, join(agentDir, "install"), join(home, ".pi", "agent", "install")].filter(Boolean)) {
    const current = join(install, "current-version");
    if (!existsSync(current)) continue;
    const version = readFileSync(current, "utf8").trim();
    if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) throw new Error("Invalid managed Pi current-version");
    return validatePiPackage(join(install, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent"));
  }
  for (const base of [env.APPDATA ? join(env.APPDATA, "npm") : undefined, join(home, ".npm-global", "lib"), join(home, ".local", "lib"), "/usr/local/lib", "/usr/lib"].filter(Boolean)) {
    const candidate = join(base, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) return validatePiPackage(candidate);
  }
  throw new Error("Pi SDK not found; use the managed installer or set PI_SDK_DIR");
}

export function dependencyRoot(name, sdkDir = findPiPackage()) {
  if (name === "@earendil-works/pi-coding-agent") return sdkDir;
  const require = createRequire(join(sdkDir, "package.json"));
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = join(base, name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`Pi dependency not found: ${name}`);
}

export function sdkAliases(sdkDir = findPiPackage()) {
  const require = createRequire(join(sdkDir, "package.json"));
  const ai = dependencyRoot("@earendil-works/pi-ai", sdkDir);
  const aiEntry = join(ai, "dist", existsSync(join(ai, "dist", "compat.js")) ? "compat.js" : "index.js");
  return {
    "@earendil-works/pi-coding-agent": join(sdkDir, "dist", "index.js"),
    "@earendil-works/pi-agent-core": join(dependencyRoot("@earendil-works/pi-agent-core", sdkDir), "dist", "index.js"),
    "@earendil-works/pi-tui": join(dependencyRoot("@earendil-works/pi-tui", sdkDir), "dist", "index.js"),
    "@earendil-works/pi-ai/compat": aiEntry,
    "@earendil-works/pi-ai": aiEntry,
    "typebox/compile": require.resolve("typebox/compile"),
    "typebox/value": require.resolve("typebox/value"),
    typebox: require.resolve("typebox"),
  };
}

export async function createPiJiti(parent, options = {}) {
  const sdkDir = findPiPackage();
  const require = createRequire(join(sdkDir, "package.json"));
  const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
  return createJiti(parent, { interopDefault: true, moduleCache: true, ...options,
    alias: { ...sdkAliases(sdkDir), ...options.alias } });
}

export function systemPromptText(context) {
  if (typeof context.systemPrompt === "string") return context.systemPrompt;
  return (context.messages ?? []).filter((message) => message.role === "system")
    .map((message) => [typeof message.content === "string" ? message.content
      : (message.content ?? []).map((part) => part.text ?? "").join("\n"),
      ...Object.values(message.sections ?? {}).filter((value) => typeof value === "string")].join("\n"))
    .join("\n");
}

export function piInvocation(args = [], sdkDir = findPiPackage()) {
  const manifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  if (!entry) throw new Error("Pi package has no CLI entry point");
  return { command: process.execPath, args: [resolve(sdkDir, entry), ...args] };
}

function validatePiPackage(path) {
  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  if (manifest.name !== "@earendil-works/pi-coding-agent" || !existsSync(join(path, "dist", "index.js"))) {
    throw new Error(`Invalid Pi SDK directory: ${path}`);
  }
  return path;
}
