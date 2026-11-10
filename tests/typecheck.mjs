import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dependencyRoot, findPiPackage } from "./runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = findPiPackage();
const packageName = process.argv[2] || "*";
if (packageName !== "*" && !/^[a-z0-9-]+$/.test(packageName)) throw new Error("Invalid package name");
const temporary = mkdtempSync(join(tmpdir(), "pi-typecheck-"));
try {
  const ai = join(dependencyRoot("@earendil-works/pi-ai", sdk), "dist", "compat.d.ts");
  const config = {
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true,
      skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
      ...(packageName === "*" ? {} : { noUnusedLocals: true, noUnusedParameters: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true }),
      allowJs: true, checkJs: false, types: ["node"],
      typeRoots: [dirname(dependencyRoot("@types/node", sdk))],
      paths: {
        "@earendil-works/pi-coding-agent": [join(sdk, "dist", "index.d.ts")],
        "@earendil-works/pi-tui": [join(dependencyRoot("@earendil-works/pi-tui", sdk), "dist", "index.d.ts")],
        "@earendil-works/pi-ai": [ai], "@earendil-works/pi-ai/compat": [ai],
        "@earendil-works/pi-agent-core": [join(dependencyRoot("@earendil-works/pi-agent-core", sdk), "dist", "index.d.ts")],
        typebox: [join(dependencyRoot("typebox", sdk), "build", "index.d.mts")],
      },
    },
    include: [join(root, `packages/${packageName}/extensions/**/*.ts`)],
    exclude: ["**/*.test.ts"],
  };
  const configPath = join(temporary, "tsconfig.json");
  writeFileSync(configPath, JSON.stringify(config));
  const result = spawnSync(process.env.PI_TSC || "tsc", ["-p", configPath], { stdio: "inherit" });
  if (result.error) throw new Error("TypeScript is unavailable; install it separately or set PI_TSC", { cause: result.error });
  process.exitCode = result.status ?? 1;
  if (result.status === 0) console.log("All extension TypeScript sources pass strict checks against the installed Pi SDK.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
